var sdr = sdr || {};
(function () {
  'use strict';
  
  // sdr.widgets contains *only* widget types and can be used as a lookup namespace
  var widgets = sdr.widgets = Object.create(null);
  
  function mod(value, modulus) {
    return (value % modulus + modulus) % modulus;
  }
  
  function SpectrumPlot(config) {
    var fftCell = config.target;
    var canvas = config.element;
    var view = config.view;
    var states = config.radio;
    
    var ctx = canvas.getContext('2d');
    ctx.canvas.width = parseInt(getComputedStyle(canvas).width);
    ctx.lineWidth = 1;
    var cssColor = getComputedStyle(canvas).color;
    var w, h, bandwidth, averageBuffer; // updated in draw
    var lastDrawnCenterFreq = NaN;
    
    function relFreqToX(freq) {
      return w * (1/2 + freq / bandwidth);
    }
    function drawHair(freq) {
      var x = relFreqToX(freq);
      x = Math.floor(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ctx.canvas.height);
      ctx.stroke();
    }
    function drawBand(freq1, freq2) {
      var x1 = relFreqToX(freq1);
      var x2 = relFreqToX(freq2);
      ctx.fillRect(x1, 0, x2 - x1, ctx.canvas.height);
    }
    
    this.draw = function () {
      var buffer = fftCell.get();
      w = ctx.canvas.width;
      h = ctx.canvas.height;
      bandwidth = states.input_rate.get();
      var len = buffer.length;
      var scale = ctx.canvas.width / len;
      var yScale = -h / (view.maxLevel - view.minLevel);
      var yZero = -view.maxLevel * yScale;
      
      // averaging
      // TODO: Get separate averaged and unaveraged FFTs from server so that averaging behavior is not dependent on frame rate over the network
      if (!averageBuffer
          || averageBuffer.length !== len
          || lastDrawnCenterFreq !== fftCell.getCenterFreq()) {
        console.log('reset');
        lastDrawnCenterFreq = fftCell.getCenterFreq();
        averageBuffer = new Float32Array(buffer);
      }
      for (var i = 0; i < len; i++) {
        averageBuffer[i] = averageBuffer[i] * 0.5 + buffer[i] * 0.5;
      }
      
      ctx.clearRect(0, 0, w, h);
      
      // TODO: marks ought to be part of a distinct widget
      var offset = states.rec_freq.get() - states.hw_freq.get();
      ctx.fillStyle = '#444';
      drawBand(offset - 56000, offset + 56000); // TODO get band_filter from server
      ctx.strokeStyle = 'gray';
      drawHair(0); // center frequency
      ctx.strokeStyle = 'white';
      drawHair(offset); // receiver
      
      //ctx.strokeStyle = 'currentColor';  // in spec, doesn't work
      ctx.strokeStyle = cssColor;
      ctx.beginPath();
      ctx.moveTo(0, yZero + averageBuffer[0] * yScale);
      for (var i = 1; i < len; i++) {
        ctx.lineTo(i * scale, yZero + averageBuffer[i] * yScale);
      }
      ctx.stroke();
      
    };
    function clickTune(event) {
      // TODO: works only because canvas is at the left edge
      var x = event.clientX / parseInt(getComputedStyle(canvas).width);
      var offsetFreq = (x * 2 - 1) / 2 * bandwidth;
      states.rec_freq.set(states.hw_freq.get() + offsetFreq);
      event.stopPropagation();
      event.preventDefault(); // no selection
    }
    canvas.addEventListener('mousedown', function(event) {
      event.preventDefault();
      document.addEventListener('mousemove', clickTune, true);
      document.addEventListener('mouseup', function(event) {
        document.removeEventListener('mousemove', clickTune, true);
      }, true);
    }, false);
  }
  widgets.SpectrumPlot = SpectrumPlot;
  
  function WaterfallPlot(config) {
    var fftCell = config.target;
    var canvas = config.element;
    var view = config.view;
    var states = config.radio;

    var ctx = canvas.getContext("2d");
    // circular buffer of ImageData objects
    var slices = [];
    var slicePtr = 0;
    var lastDrawnCenterFreq = NaN;
    this.draw = function () {
      var buffer = fftCell.get();
      var h = canvas.height;
      var currentCenterFreq = fftCell.getCenterFreq();
      
      // TODO: We don't actually want the current known center frequency, we want the center frequency _which the FFT came from_, but don't have that info currently.
      
      // rescale to discovered fft size
      var w = buffer.length;
      if (canvas.width !== w) {
        // assignment clears canvas
        canvas.width = w;
        // reallocate
        slices = [];
        slicePtr = 0;
      }
      
      // Find slice to write into
      var ibuf;
      if (slices.length < h) {
        slices.push([ibuf = ctx.createImageData(w, 1), currentCenterFreq]);
      } else {
        var record = slices[slicePtr];
        slicePtr = mod(slicePtr + 1, h);
        ibuf = record[0];
        record[1] = currentCenterFreq;
      }
      
      // low-pass filter to remove the edge-to-center variation from the spectrum (disabled because I'm not sure fiddling with the data like this is a good idea until such time as I make it an option, and so on)
      if (false) {
        var filterspan = 160;
        var filtersum = 0;
        var count = 0;
        var hpf = new Float32Array(w);
        for (var i = -filterspan; i < w + filterspan; i++) {
          if (i + filterspan < w) {
            filtersum += buffer[i + filterspan];
            count++;
          }
          if (i - filterspan >= 0) {
            filtersum -= buffer[i - filterspan];
            count--;
          }
          if (i >= 0 && i < w) {
            hpf[i] = filtersum / count;
          }
        }
      }
      
      // Generate image slice from latest FFT data.
      var scale = buffer.length / w;
      var cScale = 255 / (view.maxLevel - view.minLevel);
      var cZero = 255 - view.maxLevel * cScale;
      var data = ibuf.data;
      for (var x = 0; x < w; x++) {
        var base = x * 4;
        var i = Math.round(x * scale);
        var intensity = (buffer[i] /* - hpf[i]*/) * cScale + cZero;
        var redBound = 255 - intensity / 4;
        data[base] = intensity;
        data[base + 1] = Math.min(intensity * 2, redBound);
        data[base + 2] = Math.min(intensity * 4, redBound);
        data[base + 3] = 255;
      }
      
      if (lastDrawnCenterFreq === currentCenterFreq) {
        // Scroll
        ctx.drawImage(ctx.canvas, 0, 0, w, h-1, 0, 1, w, h-1);
        // Paint newest slice
        ctx.putImageData(ibuf, 0, 0);
      } else {
        // Paint slices onto canvas
        ctx.clearRect(0, 0, w, h);
        var sliceCount = slices.length;
        var offsetScale = w / states.input_rate.get();  // TODO parameter for rate
        for (var i = sliceCount - 1; i >= 0; i--) {
          var slice = slices[mod(i + slicePtr, sliceCount)];
          var offset = slice[1] - currentCenterFreq;
          ctx.putImageData(slice[0], Math.round(offset * offsetScale), sliceCount - i);
        }
      }
    };
  }
  widgets.WaterfallPlot = WaterfallPlot;
  
  function Knob(config) {
    var target = config.target;

    var container = this.element = document.createElement("span");
    container.className = "knob";
    var places = [];
    var marks = [];
    for (var i = 9; i >= 0; i--) (function(i) {
      if (i % 3 == 2) {
        var mark = container.appendChild(document.createElement("span"));
        mark.className = "knob-mark";
        mark.textContent = ",";
        mark.style.visibility = "hidden";
        marks.unshift(mark);
        // TODO: make marks responsive to scroll events (doesn't matter which neighbor, or split in the middle, as long as they do something).
      }
      var digit = container.appendChild(document.createElement("span"));
      digit.className = "knob-digit";
      digit.tabIndex = -1;
      var digitText = digit.appendChild(document.createTextNode("\u00A0"));
      places[i] = {element: digit, text: digitText};
      var scale = Math.pow(10, i);
      digit.addEventListener("mousewheel", function(event) { // Not in FF
        // TODO: deal with high-res/accelerated scrolling
        var adjust = event.wheelDelta > 0 ? 1 : -1;
        target.set(adjust * scale + target.get());
        event.preventDefault();
        event.stopPropagation();
      }, true);
      digit.addEventListener("keypress", function(event) {
        // TODO: arrow keys/backspace
        var input = parseInt(String.fromCharCode(event.charCode), 10);
        if (isNaN(input)) return;
        
        var value = target.get();
        var negative = value < 0;
        if (negative) { value = -value; }
        var currentDigitValue = Math.floor(value / scale) % 10;
        value += (input - currentDigitValue) * scale;
        if (negative) { value = -value; }
        target.set(value);
        
        if (i > 0) {
          places[i - 1].element.focus();
        } else {
          digit.blur();
        }
        
        event.preventDefault();
        event.stopPropagation();
      }, true);
    }(i));
    var lastShownValue = -1;
    
    this.draw = function () {
      var value = target.get();
      if (value === lastShownValue) return;
      lastShownValue = value;
      var valueStr = String(Math.round(value));
      var last = valueStr.length - 1;
      for (var i = 0; i < places.length; i++) {
        places[i].text.data = valueStr[last - i] || '\u00A0';
      }
      var numMarks = Math.floor((valueStr.replace("-", "").length - 1) / 3);
      for (var i = 0; i < marks.length; i++) {
        marks[i].style.visibility = i < numMarks ? "visible" : "hidden";
      }
    };
  }
  widgets.Knob = Knob;
  
  function FreqScale(config) {
    var tunerSource = config.target;
    var states = config.radio;
    var freqDB = config.freqDB;

    var outer = this.element = document.createElement("div");
    outer.className = "freqscale";
    var numbers = outer.appendChild(document.createElement("div"));
    numbers.className = "freqscale-numbers";
    var stations = outer.appendChild(document.createElement("div"));
    stations.className = "freqscale-stations";
    var lastShownValue = NaN;
    // TODO: reuse label nodes instead of reallocating...if that's cheaper
    this.draw = function() {
      var centerFreq = tunerSource.get();
      if (centerFreq === lastShownValue) return;
      lastShownValue = centerFreq;
      
      var bandwidth = states.input_rate.get();
      var scale = 100 / bandwidth;
      var step = 0.5e6;
      var lower = centerFreq - bandwidth / 2;
      var upper = centerFreq + bandwidth / 2;
      
      function position(freq) {
        return ((freq - centerFreq) * scale + 50) + "%";
      }
      
      numbers.textContent = "";
      for (var i = lower - mod(lower, step); i <= upper; i += step) {
        var label = numbers.appendChild(document.createElement("span"));
        label.className = "freqscale-number";
        label.textContent = (i / 1e6) + "MHz";
        label.style.left = position(i);
      }
      
      stations.textContent = "";
      freqDB.forEach(function (record) {
        var freq = record.freq;
        if (freq >= lower && freq <= upper) {
          var el = stations.appendChild(document.createElement("span"));
          el.className = "freqscale-station";
          el.textContent = record.label;
          el.style.left = position(freq);
          // TODO: be an <a> or <button>
          el.addEventListener('click', function(event) {
            states.rec_freq.set(freq);
            event.stopPropagation();
          }, false);
        }
      });
    };
  }
  widgets.FreqScale = FreqScale;
  
  function FreqList(config) {
    var rec_freq = config.target;
    var states = config.radio;
    var freqDB = config.freqDB;

    var list = this.element = document.createElement('select');
    list.className = 'freq-list';
    list.multiple = true;
    list.size = 20;
    var last = 0;
    this.draw = function () {
      // TODO proper update strategy
      if (freqDB.length === last) { return; }
      last = freqDB.length;
      
      list.textContent = '';
      freqDB.forEach(function (record) {
        var freq = record.freq;
        var item = list.appendChild(document.createElement('option'));
        item.textContent = (record.freq / 1e6).toFixed(2) + ' ' + record.label;
        item.addEventListener('click', function(event) {
          // TODO: add a generic way to properly adjust hw_freq to match rec_freq
          states.hw_freq.set(freq - 0.2e6);
          rec_freq.set(freq);
          event.stopPropagation();
        }, false);
      });
    };
  }
  widgets.FreqList = FreqList;
  
  function LogSlider(config) {
    var target = config.target;
    var slider = this.element = config.element;

    slider.addEventListener('change', function(event) {
      target.set(Math.pow(10, slider.valueAsNumber));
    }, false);
    this.draw = function () {
      var value = Math.log(target.get()) / Math.LN10;
      var shown = slider.valueAsNumber;
      if (Math.abs(value - shown) < 1e-8) return;
      slider.valueAsNumber = value;
    };
  }
  widgets.LogSlider = LogSlider;
  
  function Toggle(config) {
    var target = config.target;
    var checkbox = this.element = config.element;

    checkbox.addEventListener('change', function(event) {
      target.set(checkbox.checked);
    }, false);
    this.draw = function () {
      var value = target.get();
      if (value === checkbox.checked) return;
      checkbox.checked = value;
    };
  }
  widgets.Toggle = Toggle;
  
  Object.freeze(widgets);
}());