# Copyright 2013 Kevin Reid <kpreid@switchb.org>
#
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

from __future__ import absolute_import, division

from twisted.internet import reactor
from twisted.internet.protocol import ProcessProtocol
from twisted.protocols.basic import LineReceiver
from zope.interface import implements

from gnuradio import gr
from gnuradio import blocks

from shinysdr.modes import ModeDef, IDemodulator
from shinysdr.types import Notice
from shinysdr.values import BlockCell, ExportedState, exported_value
from shinysdr.blocks import make_sink_to_process_stdin, test_subprocess, make_resampler
from shinysdr.plugins.basic_demod import NFMDemodulator
from shinysdr.plugins.aprs import parse_tnc2, APRSInformation

pipe_rate = 22050  # what multimon-ng expects
_maxint32 = 2 ** 15 - 1
audio_gain = 0.5
int_scale = _maxint32 * audio_gain

class MultimonNGDemodulator(gr.hier_block2, ExportedState):
	implements(IDemodulator)
	
	def __init__(self, mode, input_rate=0, context=None):
		assert input_rate > 0
		gr.hier_block2.__init__(
			self, str(mode) + ' (Multimon-NG) demodulator',
			gr.io_signature(1, 1, gr.sizeof_gr_complex * 1),
			# TODO: Add generic support for demodulators with no audio output
			gr.io_signature(2, 2, gr.sizeof_float * 1),
		)
		self.mode = mode
		self.input_rate = input_rate
		
		self.information = APRSInformation()
		
		# FM demod
		self.fm_demod = NFMDemodulator(
			mode='NFM',
			input_rate=input_rate,
			tau=None)  # no deemphasis
		fm_audio_rate = self.fm_demod.get_audio_rate()
		
		# Subprocess
		# using /usr/bin/env because twisted spawnProcess doesn't support path search
		process = reactor.spawnProcess(
			MultimonNGProcessProtocol(self.information.receive),
			'/usr/bin/env',
			env=None,  # inherit environment
			args=['env', 'multimon-ng', '-t', 'raw', '-a', 'AFSK1200', '-A', '-v', '10', '-'],
			#args=['env', 'python', '../play16bit.py'],
			childFDs={
				0: 'w',
				1: 'r',
				2: 2
			})
		sink = make_sink_to_process_stdin(process, itemsize=gr.sizeof_short)
		
		# Output
		converter = blocks.float_to_short(vlen=1, scale=int_scale)
		self.connect(
			self,
			self.fm_demod,
			make_resampler(fm_audio_rate, pipe_rate),
			converter,
			sink)
		# Dummy sink for useless stereo output of demod
		self.connect((self.fm_demod, 1), blocks.null_sink(gr.sizeof_float))
		# Audio copy output
		unconverter = blocks.short_to_float(vlen=1, scale=int_scale)
		self.connect(converter, unconverter)
		self.connect(unconverter, (self, 0))
		self.connect(unconverter, (self, 1))
		
	def state_def(self, callback):
		super(MultimonNGDemodulator, self).state_def(callback)
		# TODO make this possible to be decorator style
		callback(BlockCell(self, 'information'))

	def can_set_mode(self, mode):
		return False
	
	def get_half_bandwidth(self):
		return self.fm_demod.get_half_bandwidth()
	
	def get_audio_rate(self):
		return pipe_rate
	
	@exported_value()
	def get_band_filter_shape(self):
		return self.fm_demod.get_band_filter_shape()


class MultimonNGProcessProtocol(ProcessProtocol):
	def __init__(self, target):
		self.__target = target
		self.__line_receiver = LineReceiver()
		self.__line_receiver.delimiter = '\n'
		self.__line_receiver.lineReceived = self.__lineReceived
		self.__last_line = None
	
	def outReceived(self, data):
		# split lines
		self.__line_receiver.dataReceived(data)
		
	def errReceived(self, data):
		# we should inherit stderr, not pipe it
		raise Exception('shouldn\'t happen')
	
	def __lineReceived(self, line):
		if line == '':  # observed glitch in output
			pass
		elif line.startswith('Enabled demodulators:'):
			pass
		elif line.startswith('$ULTW') and self.__last_line is not None:  # observed glitch in output; need to glue to previous line, I think?
			ll = self.__last_line
			self.__last_line = None
			self.__target(ll + line)
		elif line.startswith('APRS: '):
			line = line[len('APRS: '):]
			self.__last_line = line
			self.__target(line)
		else:
			# TODO: Log these properly
			print 'Not APRS line: %r' % line


# TODO: Arrange for a way for the user to see why it is unavailable.
pluginDef_APRS = ModeDef('APRS', label='APRS', demodClass=MultimonNGDemodulator,
	available=test_subprocess('multimon-ng -h; exit 0', 'available demodulators:', shell=True))
