// Copyright 2013, 2014, 2015 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['./values', './gltools', './widget', './widgets', './events', './network'], function (values, gltools, widget, widgets, events, network) {
  'use strict';
  
  var sin = Math.sin;
  var cos = Math.cos;
  
  var AddKeepDrop = events.AddKeepDrop;
  var any = values.any;
  var block = values.block;
  var Banner = widgets.Banner;
  var Cell = values.Cell;
  var Clock = events.Clock;
  var ConstantCell = values.ConstantCell;
  var createWidgetExt = widget.createWidgetExt;
  var DerivedCell = values.DerivedCell;
  var makeBlock = values.makeBlock;
  var PickBlock = widgets.PickBlock;
  var SmallKnob = widgets.SmallKnob;
  var StorageCell = values.StorageCell;
  var Toggle = widgets.Toggle;
  var externalGet = network.externalGet;
  
  var exports = {};
  
  // Degree trig functions.
  // We use degrees in this module because degrees are standard for latitude and longitude, and are also useful for more exact calculations because 360 is exactly representable as a floating-point number whereas 2π is not.
  // TODO: Look at the edge cases and see if it would be useful to have dcos & dsin do modulo 360, so we get that exactness for them.
  var RADIANS_PER_DEGREE = Math.PI / 180;
  function dcos(x) { return cos(RADIANS_PER_DEGREE * x); }
  function dsin(x) { return sin(RADIANS_PER_DEGREE * x); }
  
  function mod(a, b) {
    return ((a % b) + b) % b;
  }
  function mean(array) {
    return array.reduce(function (a, b) { return a + b; }, 0) / array.length;
  }

  // Clock for position animations
  var clock = new Clock(0.1);
  
  // Process touch events to implement one- and two-finger pan/zoom gestures
  // Moves as if the space is linear but can tolerate it not actually being.
  // Does not provide rotation or tilt.
  function TouchZoomHandler(targetElement, view, tapHandler) {
    // TODO: This was derived from the touch handling in SpectrumView. Now that we've gener
    var activeTouches = Object.create(null);
    var touchCanBeTap = false;
    var stateAtStart = null;
    
    targetElement.addEventListener('touchstart', function (event) {
      // Prevent mouse-emulation handling
      event.preventDefault();

      touchCanBeTap = Object.keys(activeTouches).length === 0 && event.changedTouches.length == 1;
      
      if (Object.keys(activeTouches).length === 0) {  // is first touch
        stateAtStart = view.captureState();
      }

      // Record the initial position the user has touched
      Array.prototype.forEach.call(event.changedTouches, function (touch) {
        var rect = targetElement.getBoundingClientRect();
        var localX = touch.clientX - rect.left;
        var localY = touch.clientY - rect.top;

        activeTouches[touch.identifier] = {
          grabViewX: localX,  // fixed
          grabViewY: localY,  // fixed
          nowViewX: localX,  // updated later
          nowViewY: localY  // updated later
        };
      });
    }, false);

    targetElement.addEventListener('touchmove', function (event) {
      var rect = targetElement.getBoundingClientRect();
      
      Array.prototype.forEach.call(event.changedTouches, function (touch) {
        var localX = touch.clientX - rect.left;
        var localY = touch.clientY - rect.top;

        activeTouches[touch.identifier].nowViewX = localX;
        activeTouches[touch.identifier].nowViewY = localY;
      });

      var deltaScale = 1;
      if (Object.keys(activeTouches).length >= 2) {
        // Zoom using first two touches
        var grab1X = activeTouches[0].grabViewX;
        var grab1Y = activeTouches[0].grabViewY;
        var grab2X = activeTouches[1].grabViewX;
        var grab2Y = activeTouches[1].grabViewY;
        var now1X = activeTouches[0].nowViewX;
        var now1Y = activeTouches[0].nowViewY;
        var now2X = activeTouches[1].nowViewX;
        var now2Y = activeTouches[1].nowViewY;
        var deltaScaleX = Math.abs(now2X - now1X) / Math.abs(grab2X - grab1X);
        var deltaScaleY = Math.abs(now2Y - now1Y) / Math.abs(grab2Y - grab1Y);
        deltaScale = (deltaScaleX + deltaScaleY) / 2;
      }
      
      // Compute pan pos
      var grabsX = [];
      var grabsY = [];
      var pansX = [];
      var pansY = [];
      for (var idString in activeTouches) {
        var info = activeTouches[idString];
        grabsX.push(info.grabViewX - rect.width / 2);
        grabsY.push(info.grabViewY - rect.height / 2);
        pansX.push(info.nowViewX - info.grabViewX);
        pansY.push(info.nowViewY - info.grabViewY);
      }
      
      if (!stateAtStart) throw new Error('shouldn\'t happen');
      var grabPartX = -mean(grabsX);
      var grabPartY = -mean(grabsY);
      view.setState(
        stateAtStart,
        grabPartX,
        grabPartY,
        mean(pansX) - grabPartX,
        mean(pansY) - grabPartY,
        deltaScale);

    }, true);

    function touchcancel(event) {
      // Prevent mouse-emulation handling
      event.preventDefault();
      Array.prototype.forEach.call(event.changedTouches, function (touch) {
        delete activeTouches[touch.identifier];
      });
      
      // Each time a touch goes away, lock in the current view mapping.
      stateAtStart = view.captureState();
      for (var idString in activeTouches) {
        var info = activeTouches[idString];
       info.grabViewX = info.nowViewX;
       info.grabViewY = info.nowViewY;
      }
    }
    targetElement.addEventListener('touchcancel', touchcancel, true);

    targetElement.addEventListener('touchend', function (event) {
      // Prevent mouse-emulation handling
      event.preventDefault();

      if (touchCanBeTap) {
        var touch = event.changedTouches[0];  // known to be exactly one

        var rect = targetElement.getBoundingClientRect();
        var localX = touch.clientX - rect.left;
        var localY = touch.clientY - rect.top;

        var info = activeTouches[touch.identifier];
        //console.log('maybe tap', localX, info.grabViewX, localY, info.grabViewY);
        if (Math.hypot(localX - info.grabViewX, localY - info.grabViewY) < 20) {  // TODO justify choice of slop
          //console.log('actually tap');
          tapHandler(touch, info.grabDocX, info.grabDocY);  // TOOD bad interface
        }
      }

      // Forget the touch
      touchcancel(event);
    }, true);
  }

  function newMat4() {
    return new Float32Array(16);
  }
  function matInd(minor, major) {
    return minor + major * 4;
  }
  function setRotMat(mat, axis0, angle) {
    var axis1 = (axis0 + 1) % 3;
    var axis2 = (axis0 + 2) % 3;
    var c = cos(angle);
    var s = sin(angle);
    mat[matInd(axis0, axis0)] = 1;
    mat[matInd(axis1, axis0)] = 0;
    mat[matInd(axis2, axis0)] = 0;
    mat[matInd(axis0, axis1)] = 0;
    mat[matInd(axis1, axis1)] = c;
    mat[matInd(axis2, axis1)] = -s;
    mat[matInd(axis0, axis2)] = 0;
    mat[matInd(axis1, axis2)] = s;
    mat[matInd(axis2, axis2)] = c;
    mat[matInd(3, 0)] = 0;
    mat[matInd(3, 1)] = 0;
    mat[matInd(3, 2)] = 0;
    mat[matInd(0, 3)] = 0;
    mat[matInd(1, 3)] = 0;
    mat[matInd(2, 3)] = 0;
    mat[matInd(3, 3)] = 1;
  }
  function setScaleMat(mat, scale) {
    mat[0] = scale;
    mat[1] = 0;
    mat[2] = 0;
    mat[3] = 0;
    mat[4] = 0;
    mat[5] = scale;
    mat[6] = 0;
    mat[7] = 0;
    mat[8] = 0;
    mat[9] = 0;
    mat[10] = scale;
    mat[11] = 0;
    mat[12] = 0;
    mat[13] = 0;
    mat[14] = 0;
    mat[15] = 1;
  }
  function multMat(out, a, b) {
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) {
          sum += a[matInd(i, k)] * b[matInd(k, j)];
        }
        out[matInd(i, j)] = sum;
      }
    }
  }
  
  // TODO this is no longer generally useful
  // write [x, y, z, lon, lat] to array
  // lat, lon in degrees
  function writeCoords(array, base, lat, lon) {
    array[base    ] = dcos(lat) * dsin(lon);
    array[base + 1] = dsin(lat);
    array[base + 2] = dcos(lat) * -dcos(lon);
    array[base + 3] = lon;
    array[base + 4] = lat;
  }
  
  // TODO: Tests. Like what happens if width is bigger than texture.
  function StripeAllocator(width, height, stripeHeight) {
    this._width = width;
    this._height = height;
    this._stripeHeight = stripeHeight;
    this._stripes = [];
    for (var i = 0, y = 0; y < height; i++, y += stripeHeight) {
      this._stripes[i] = [{start: 0, width: width}];
    }
  }
  StripeAllocator.prototype.allocate = function (allocWidth, allocName, onDestroy) {
    allocWidth = Math.min(Math.ceil(allocWidth), this._width);
    var allocator = this;
    var stripes = this._stripes;
    var ns = stripes.length;
    for (var stripeIndex = 0; stripeIndex < ns; stripeIndex++) {
      var stripe = stripes[stripeIndex];
      for (var j = 0; j < stripe.length; j++) {
        var freeEntry = stripe[j];
        if (freeEntry.width >= allocWidth) {
          var allocated = freeEntry.start;
          var remainder = freeEntry.width - allocWidth;
          if (remainder > 0) {
            freeEntry.start += allocWidth;
            freeEntry.width = remainder;
          } else {
            stripe.splice(j, 1);
          }
          var refCount = 1;
          return {
            x: allocated,
            y: stripeIndex * this._stripeHeight,
            incRefCount: function() {
              refCount++;
            },
            decRefCount: function() {
              refCount--;
              if (refCount == 0) {
                allocator._deallocate(stripeIndex, allocated, allocWidth);
                onDestroy();
              } else if (refCount < 0) {
                console.error('unbalanced refcount!', refCount, allocName);
              }
            }
          };
        }
      }
    }
    return null;
  };
  StripeAllocator.prototype._deallocate = function (stripeIndex, start, width) {
    // TODO coalesce
    this._stripes[stripeIndex].push({start: start, width: width});
  }
  
  function FreeListAllocator(initialSize, grow) {
    if (initialSize <= 0 || initialSize != (initialSize | 0)) {
      throw new Error('initialSize must be a positive integer');
    }
    this._size = initialSize;
    var list = this._list = [];
    this._grow = grow;
    for (var i = 0; i < initialSize; i++) {
      list.push(i);
    }
  }
  FreeListAllocator.prototype.allocate = function() {
    var list = this._list;
    if (!(list.length > 0)) {
      var oldSize = this._size;
      var newSize = oldSize * 2;
      this._size = newSize;
      for (var i = oldSize; i < newSize; i++) {
        list.push(i);
      }
      (0, this._grow)(newSize);
    }
    return list.pop();
  };
  FreeListAllocator.prototype.deallocate = function(index) {
    if ((index | 0) !== index) {
      throw new Error('FreeListAllocator given not an integer: ' + index);
    }
    this._list.push(index);
  };
  
  var imageLoadCache = Object.create(null);
  function loadImage(url, callback) {
    var img;
    if (url in imageLoadCache) {
      img = imageLoadCache[url];
    } else {
      img = document.createElement('img');
      img.src = url;
      imageLoadCache[url] = img;
    }
    
    // TODO: handle load error
    if (img.complete) {
      callback(img);  // TODO use scheduler, but scheduler doesn't do args
    } else {
      img.addEventListener('load', function (event) {
        callback(img);
      }, true);
    }
  }
  
  function GLSphere(gl, redrawCallback) {
    var vertexShaderSource = ''
      + 'attribute mediump vec3 position;\n'
      + 'attribute highp vec2 lonlat;\n'
      + 'uniform highp mat4 projection;\n'
      + 'varying highp vec2 v_lonlat;\n'
      + 'varying highp vec3 v_position;\n'
      + 'void main(void) {\n'
      + '  gl_Position = vec4(position, 1.0) * projection;\n'
      + '  v_lonlat = lonlat;\n'
      + '  v_position = position;\n'
      + '}\n';
    var fragmentShaderSource = ''
      + 'varying highp vec2 v_lonlat;\n'
      + 'varying highp vec3 v_position;\n'
      + 'uniform sampler2D texture;\n'
      + 'uniform lowp vec3 sun;\n'
      + 'void main(void) {\n'
      + '  lowp vec4 texture = texture2D(texture, mod(v_lonlat + vec2(180.0, 90.0), 360.0) * vec2(1.0/360.0, -1.0/180.0) + vec2(0.0, 1.0));\n'
      + '   lowp float light = mix(1.0, clamp(dot(v_position, sun) * 10.0 + 1.0, 0.0, 1.0), 0.25);'
      + '   gl_FragColor = vec4(texture.rgb * light, texture.a);\n'
      + '}\n';
    var program = gltools.buildProgram(gl, vertexShaderSource, fragmentShaderSource);
    var att_position = gl.getAttribLocation(program, 'position');
    var att_lonlat = gl.getAttribLocation(program, 'lonlat');
    gl.uniform1i(gl.getUniformLocation(program, 'texture'), 0);
    
    function fetchSun() {
      // TODO relative url bad idea
      externalGet('ephemeris', 'text', function (response) {
        var xyz = JSON.parse(response);
      
        gl.useProgram(program);
        gl.uniform3fv(gl.getUniformLocation(program, 'sun'), xyz);
        gl.useProgram(null);
        redrawCallback.scheduler.enqueue(redrawCallback);
      });
    }
    fetchSun();
    setInterval(fetchSun, 1000 * 60 * 15);
    
    var sphereTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sphereTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    // TODO: Get a power-of-two texture and enable repeating, so that we don't have an artifact at 180° longitude.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // placeholder image
    var baseGray = Math.round(0.83 * 255);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0, // level
      gl.RGBA, // internalformat
      1, 1, 0, // width, height, border
      gl.RGBA, // format
      gl.UNSIGNED_BYTE, // type
      new Uint8Array([baseGray, baseGray, baseGray, 255]));
    // TODO: Make this enableable/configurable.
    if (false) loadImage('/client/NE1_50M_SR_W_rescaled.jpg', function(img) {
      gl.bindTexture(gl.TEXTURE_2D, sphereTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0, // level
        gl.RGBA, // internalformat
        gl.RGBA, // format
        gl.UNSIGNED_BYTE, // type
        img);
      gl.bindTexture(gl.TEXTURE_2D, null);
      redrawCallback.scheduler.enqueue(redrawCallback);
    });
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    var sphereVertBuffer = gl.createBuffer();
    var sphereIndexBuffer = gl.createBuffer();
    var sphereData, sphereIndices;
    var sphereDataComponents = 5;
    (function () {
      var latLines = 50;
      var lonLines = 100;
      var latTiles = latLines - 1;
      var lonTiles = lonLines - 1;
      sphereData = new Float32Array(latLines * lonLines * sphereDataComponents);
      sphereIndices = new Uint16Array(latTiles * lonTiles * 6);
      function latDeg(lat) { return (lat - latTiles / 2) * (180 / latTiles); }
      function lonDeg(lon) { return lon * (360 / lonTiles); }
      function llindex(lat, lon) {
        if (lat < 0 || lon < 0 || lat >= latLines || lon >= lonLines) throw new Error('range');
        return lat * lonLines + lon;
      }
      for (var lat = 0; lat < latLines; lat++) {
        for (var lon = 0; lon < lonLines; lon++) {
          var base = llindex(lat, lon) * sphereDataComponents;
          writeCoords(sphereData, base, latDeg(lat), lonDeg(lon));
        }
      }
      for (var lat = 0; lat < latTiles; lat++) {
        for (var lon = 0; lon < lonTiles; lon++) {
          var base = (lat * lonTiles + lon) * 6;
          sphereIndices[base + 0] = llindex(lat + 0, lon + 0);
          sphereIndices[base + 1] = llindex(lat + 0, lon + 1);
          sphereIndices[base + 2] = llindex(lat + 1, lon + 1);
          sphereIndices[base + 3] = llindex(lat + 1, lon + 1);
          sphereIndices[base + 4] = llindex(lat + 1, lon + 0);
          sphereIndices[base + 5] = llindex(lat + 0, lon + 0);
        }
      }
    }());
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereVertBuffer);
    var BPE = Float32Array.BYTES_PER_ELEMENT;
    var stride = sphereDataComponents * BPE;
    gl.bufferData(gl.ARRAY_BUFFER, sphereData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphereIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    
    this.program = function () { return program; };  // TODO kludge
    
    this.draw = function (picking) {
      gl.bindBuffer(gl.ARRAY_BUFFER, sphereVertBuffer);
      gl.vertexAttribPointer(att_position, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(att_lonlat, 2, gl.FLOAT, false, stride, 3 * BPE);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      gl.enableVertexAttribArray(att_position);
      gl.enableVertexAttribArray(att_lonlat);
      
      gl.bindTexture(gl.TEXTURE_2D, sphereTexture);
      
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIndexBuffer);
      gl.drawElements(gl.TRIANGLES, sphereIndices.length, gl.UNSIGNED_SHORT, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      
      gl.bindTexture(gl.TEXTURE_2D, null);
      
      gl.disableVertexAttribArray(att_position);
      gl.disableVertexAttribArray(att_lonlat);
    };
  }

  function LabelTextureManager(gl, scheduler, maxHeight, redrawCallback) {
    var labelsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, labelsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Set up 2D context for rendering text labels and such
    var labelRenderCanvas = document.createElement('canvas');
    labelRenderCanvas.width = 1024;
    // TODO: Set up height (and width) depending on number of records we need to show
    labelRenderCanvas.height = 1024;
    // debug: document.body.appendChild(labelRenderCanvas);
    var labelRenderCtx = labelRenderCanvas.getContext('2d');
    
    // Whether the canvas has been drawn on but not copied to the texture.
    var textureDirty = false;

    var textureAllocator = new StripeAllocator(labelRenderCanvas.width, labelRenderCanvas.height, maxHeight + 2); // 2px bleed guard

    this.texture = function () { return labelsTexture; };

    var labelCache = Object.create(null);
    function refLabel(width, xoff, yoff, name, paintFn) {
      if (width == 0 && invisibleLabel) {
        return invisibleLabel.incRefCount();
      }
      var cacheKey = [xoff, yoff, name].toString();  // unambiguous because xoff and yoff are always numbers
      if (cacheKey in labelCache) {
        return labelCache[cacheKey].incRefCount();
      }
      function destroyLabel() {
        delete labelCache[cacheKey];
      }
      var labelAlloc = textureAllocator.allocate(width + 2, name, destroyLabel);  // 2px bleed guard
      if (!labelAlloc) {
        // allocation failure
        if (!errorMarkerLabel) {
          throw new Error('couldn\'t even allocate errorMarkerLabel');
        }
        console.error('Failed to allocate label texture space for:', name);
        return errorMarkerLabel.incRefCount();
      }
      labelRenderCtx.clearRect(labelAlloc.x, labelAlloc.y, width, maxHeight);
      if (true) {
        paintFn(labelRenderCtx, labelAlloc.x, labelAlloc.y);
      } else {
        // debug allocation regions
        //labelRenderCtx.fillStyle = 'rgba(255, 0, 0, 0.5)';
        labelRenderCtx.strokeRect(labelAlloc.x, labelAlloc.y, width, maxHeight);
      }
      textureDirty = true;
      return labelCache[cacheKey] = {
        tnx: (labelAlloc.x) / labelRenderCanvas.width,
        tpx: (labelAlloc.x + width) / labelRenderCanvas.width,
        tny: (labelAlloc.y + maxHeight) / labelRenderCanvas.height,
        tpy: (labelAlloc.y) / labelRenderCanvas.height,
        bnx: xoff - width / 2,
        bpx: xoff + width / 2,
        bny: yoff - maxHeight / 2,
        bpy: yoff + maxHeight / 2,
        bnz: -yoff / 10 + 0,
        bpz: -yoff / 10 - 1,
        incRefCount: function () {
          labelAlloc.incRefCount();
          return this;
        },
        decRefCount: function () {
          labelAlloc.decRefCount();
          // TODO: make this object obviously unusable when dealloced
        }
      };
    }
    this.refLabel = refLabel;
    
    var invisibleLabel = refLabel(0, 0, 0, "invisible", function () {});
    this.getInvisibleLabel = function () { return invisibleLabel; };
    
    var errorMarkerLabel = refLabel(maxHeight * 2, 0, 0, "errorMarker", function (ctx, x, y) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'red';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + maxHeight * 2, y + maxHeight);
      ctx.moveTo(x + maxHeight * 2, y);
      ctx.lineTo(y, y + maxHeight);
      ctx.stroke();
    });
    
    var textLabelCache = Object.create(null);
    this.refTextLabel = function refTextLabel(xanchor, xoff, yoff, text) {
      var textWidth = labelRenderCtx.measureText(text).width;
      xoff += textWidth / 2 * xanchor;
      function paintTextLabel(ctx, x, y) {
        // TODO save/restore state
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'white';
        ctx.font = '12px sans-serif';
        ctx.strokeText(text, x, y + maxHeight * 0.8);
        ctx.fillText(text, x, y + maxHeight * 0.8);
      }
      return refLabel(textWidth, xoff, yoff, JSON.stringify(text), paintTextLabel);
    }
    
    this.refIconLabel = function refIconLabel(xoff, yoff, url) {
      return refLabel(maxHeight, xoff, yoff, url, function paintIconLabel(ctx, x, y) {
        loadImage(url, function (img) {
          ctx.drawImage(img, x, y, maxHeight, maxHeight);
          textureDirty = true;
          redrawCallback.scheduler.enqueue(redrawCallback);
        });
      });
    };
    
    this.writeTextureIfNeededAndLeaveBound = function writeTextureIfNeededAndLeaveBound() {
      gl.bindTexture(gl.TEXTURE_2D, labelsTexture);
      if (!textureDirty) {
        return;
      }
      textureDirty = false;
      // TODO: stop using a texture-sized canvas and use texSubImage2D instead, to avoid using more memory and copying more than we need. Not doing that yet because being able to look at the canvas is useful for debugging.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0, // level
        gl.RGBA, // internalformat
        gl.RGBA, // format
        gl.UNSIGNED_BYTE, // type
        labelRenderCanvas);
    };
  }

  var NO_PICKING_COLOR = 0;

  function GLFeatureLayers(gl, scheduler, primitive, pickingColorAllocator, specialization) {
    var vertexShaderSource = ''
      + 'attribute vec3 position;\n'
      + 'attribute vec4 velocityAndTimestamp;\n'
      + 'attribute vec3 billboard;\n'
      + 'attribute vec3 texcoordAndOpacity;\n'
      + 'attribute vec4 pickingColor;\n'
      + 'uniform highp float time;\n'
      + 'uniform mat4 projection;\n'
      + 'uniform vec3 billboardScale;\n'
      + 'varying lowp vec3 v_texcoordAndOpacity;\n'
      + 'varying mediump vec4 v_pickingColor;\n'  // TODO figure out necessary resolution
      + 'void main(void) {\n'
      + '  vec3 velocity = velocityAndTimestamp.xyz;\n'
      + '  highp float timestamp = velocityAndTimestamp.w;\n'
      + '  highp float speed = length(velocity);\n'
      + '  vec3 forward = speed > 0.0 ? normalize(velocity) : vec3(0.0);\n'
      + '  highp float distance = speed * (time - timestamp);\n'
      + '  vec3 currentPosition = cos(distance) * position + sin(distance) * forward;\n'
      + '  gl_Position = vec4(currentPosition, 1.0) * projection + vec4(billboard * billboardScale, 0.0);\n'
      + '  v_texcoordAndOpacity = texcoordAndOpacity;\n'
      + '  v_pickingColor = pickingColor;\n'
      + '  velocity;\n'
      + '}\n';
    var program = gltools.buildProgram(gl, vertexShaderSource, specialization.fragmentShader);
    var attLayout = new gltools.AttributeLayout(gl, program, [
      { name: 'position', components: 3 },
      { name: 'velocityAndTimestamp', components: 4 },
      { name: 'billboard', components: 3 },
      { name: 'texcoordAndOpacity', components: 3 },
      { name: 'pickingColor', components: 4 },
    ]);

    // buffer layout constants
    var VERTS_PER_QUAD = specialization.VERTS_PER_INDEX;  // TODO use index buffers
    var FLOATS_PER_VERT = attLayout.elementsPerVertex();
    var FLOATS_PER_QUAD = VERTS_PER_QUAD * FLOATS_PER_VERT;
    
    this.program = function () { return program; };  // TODO kludge
    
    this.createLayer = function (arrayCell, renderer, clickHandler, redrawCallback) {
      var vertBuffer = gl.createBuffer();
      var vertBufferInitialSize = 1;  // for documentation purposes
      var vertBufferArray = new Float32Array(vertBufferInitialSize * FLOATS_PER_QUAD);
      var numberOfVertices = vertBufferInitialSize * VERTS_PER_QUAD;
      // indices are per quad
      var indexFreeList = new FreeListAllocator(vertBufferInitialSize, function grow(newSize) {
        var newArray = new Float32Array(newSize * FLOATS_PER_QUAD);
        newArray.set(vertBufferArray, 0);
        vertBufferArray = newArray;
        numberOfVertices = newSize * VERTS_PER_QUAD;
        vertBufferNeedsWrite = true; // make sure buffer is not smaller than numberOfVertices
      });
      var layerState = specialization.createLayer();
      
      var currentAnimatedFeatures = new Set();
      
      var o_position = attLayout.offsets.position;
      var o_velocityAndTimestamp = attLayout.offsets.velocityAndTimestamp;
      var o_billboard = attLayout.offsets.billboard;
      var o_texcoordAndOpacity = attLayout.offsets.texcoordAndOpacity;
      var o_pickingColor = attLayout.offsets.pickingColor;
      function writeVertex(index, offset, label, rendered, xd, yd, pickingColor) {
        var base = index * FLOATS_PER_QUAD + offset * FLOATS_PER_VERT;
        var lat = (rendered.position || [0, 0])[0];
        var lon = (rendered.position || [0, 0])[1];
        var coslat = dcos(lat);
        var coslon = dcos(lon);
        var sinlat = dsin(lat);
        var sinlon = dsin(lon);
        var instant = clock.convertFromTimestampSeconds(rendered.timestamp || 0);
        var radiansPerSecondSpeed = (rendered.speed || 0) * ((Math.PI * 2) / 40075e3)
        var opacity = isFinite(rendered.opacity) ? rendered.opacity : 1.0;
        var zFudge = -opacity;  // until we do proper depth sorting, this helps opaque things be in front of transparent things
        
        // Velocity in north=X east=Y tangent space
        var planarXVel = dsin(rendered.vangle || 0) * radiansPerSecondSpeed;
        var planarYVel = dcos(rendered.vangle || 0) * radiansPerSecondSpeed;
        // Rotate it according to the latitude
        // (rotation matrix is incomplete because radial velocity is always zero)
        var latRotXVel = planarXVel;
        var latRotYVel = planarYVel * coslat;
        var latRotZVel = planarYVel * sinlat;
        // Rotate it according to the longitude
        var finalXVel = latRotXVel * coslon - latRotZVel * sinlon;
        var finalYVel = latRotYVel;
        var finalZVel = latRotZVel * coslon + latRotXVel * sinlon;
        
        vertBufferArray[base + o_position    ] = coslat * sinlon;
        vertBufferArray[base + o_position + 1] = sinlat;
        vertBufferArray[base + o_position + 2] = coslat * -coslon;
        vertBufferArray[base + o_velocityAndTimestamp + 0] = finalXVel;
        vertBufferArray[base + o_velocityAndTimestamp + 1] = finalYVel;
        vertBufferArray[base + o_velocityAndTimestamp + 2] = finalZVel;
        vertBufferArray[base + o_velocityAndTimestamp + 3] = instant;
        vertBufferArray[base + o_billboard + 0] = label['b' + xd + 'x'];  // TODO better data structure
        vertBufferArray[base + o_billboard + 1] = label['b' + yd + 'y'];
        vertBufferArray[base + o_billboard + 2] = label['b' + yd + 'z'] + zFudge;
        vertBufferArray[base + o_texcoordAndOpacity + 0] = label['t' + xd + 'x'];
        vertBufferArray[base + o_texcoordAndOpacity + 1] = label['t' + yd + 'y'];
        vertBufferArray[base + o_texcoordAndOpacity + 2] = opacity;
        vertBufferArray[base + o_pickingColor + 0] = ((pickingColor >>  0) & 0xFF) / 255;
        vertBufferArray[base + o_pickingColor + 1] = ((pickingColor >>  8) & 0xFF) / 255;
        vertBufferArray[base + o_pickingColor + 2] = ((pickingColor >> 16) & 0xFF) / 255;
        vertBufferArray[base + o_pickingColor + 3] = ((pickingColor >> 24) & 0xFF) / 255;
      }

      var vertBufferNeedsWrite = true;
      
      var bufferAllocations = new AddKeepDrop(function featureAdded(feature) {
        var pickingColorAlloc = pickingColorAllocator.allocate();
        var pickingColor = pickingColorAlloc.index;
        pickingColorAlloc.assign({
          feature: feature,
          clickOnFeature: function () { clickHandler(feature); }
        });
        var spInfo = specialization.allocateFeature(vertBufferArray, indexFreeList, feature);
        var indexAndFlag = {
          spInfo: spInfo,
          dead: false,
          pickingColorAlloc: pickingColorAlloc
        };
        //console.log('adding', feature.label, iconIndex, textIndex);
        
        function updateFeatureRendering() {
          if (indexAndFlag.dead) return;
          var animated = specialization.updateFeatureRendering(layerState, updateFeatureRendering, indexFreeList, feature, writeVertex, spInfo, renderer, pickingColor);
          if (animated) {
            currentAnimatedFeatures.add(feature);
          } else {
            currentAnimatedFeatures.delete(feature);
          }
          vertBufferNeedsWrite = true;
          scheduler.enqueue(redrawCallback);
        }
        updateFeatureRendering.scheduler = scheduler;
        updateFeatureRendering();
        return indexAndFlag;
      }, function featureRemoved(feature, indexAndFlag) {
        //console.log('removing', feature.label, index);
        indexAndFlag.dead = true;
        specialization.deallocateFeature(layerState, writeVertex, indexFreeList, feature, indexAndFlag.spInfo);
        pickingColorAllocator.deallocate(indexAndFlag.pickingColorAlloc);
        currentAnimatedFeatures.delete(feature);
        vertBufferNeedsWrite = true;
        scheduler.enqueue(redrawCallback);
      });
      
      function dumpArray() {
        bufferAllocations.begin();
        var array = arrayCell.depend(dumpArray);
        array.forEach(function (feature) {
          bufferAllocations.add(feature);
        });
        bufferAllocations.end();
      }
      dumpArray.scheduler = scheduler;
      dumpArray();
      
      // properties of renderer's return value:
      // position (latlon or null to temporarily hide)
      // label (string)
      // timestamp: time at which current position = specified position, in unix-epoch seconds
      // vangle (number or null): angle of horizontal velocity vector
      // speed (number or null): horizontal speed in m/s
      // iconURL (string or falsy/absent for default): icon
      // labelSide: ('top', 'left', 'right', 'bottom', 'center')
      // opacity: 0..1

      return {
        draw: function (picking) {
          specialization.beforeDraw(program);
          
          gl.uniform3f(gl.getUniformLocation(program, 'billboardScale'), 2/gl.canvas.width, 2/gl.canvas.height, 0.01);

          if (picking) {
            gl.disable(gl.BLEND);  // should be disabled already, but...
          } else {
            gl.enable(gl.BLEND);
          }
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);


          gl.uniform1i(gl.getUniformLocation(program, 'picking'), picking);
          
          if (currentAnimatedFeatures.size > 0) {
            // if we don't have any animated features, don't depend on the clock
            gl.uniform1f(gl.getUniformLocation(program, 'time'), clock.depend(redrawCallback));
          }
          
          gl.bindBuffer(gl.ARRAY_BUFFER, vertBuffer);
          if (vertBufferNeedsWrite) {
            // TODO: use hint other than STATIC_DRAW when applicable
            gl.bufferData(gl.ARRAY_BUFFER, vertBufferArray, gl.STATIC_DRAW);
            vertBufferNeedsWrite = false;
          }
          attLayout.attrib();
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          gl.drawArrays(primitive, 0, numberOfVertices);
          attLayout.unattrib();

          gl.disable(gl.BLEND);
          
          specialization.afterDraw();
        }
      };
    };
  }
  
  function GLPointLayers(gl, scheduler, globalRedrawCallback, pickingColorAllocator) {
    var textRowHeight = 13;
    var labelTextureManager = new LabelTextureManager(gl, scheduler, textRowHeight, globalRedrawCallback);
    
    function writeQuad(labelsByIndex, writeVertex, index, rendered, label, pickingColor) {
      label.incRefCount();
      if (labelsByIndex[index]) {
        //console.log('replacing', index, labelsByIndex[index], label);
        labelsByIndex[index].decRefCount();
        //console.log('replaced');
      } else {
        //console.log('introducing', index);
      }
      labelsByIndex[index] = label;
      writeVertex(index, 0, label, rendered, 'n', 'n', pickingColor);
      writeVertex(index, 1, label, rendered, 'p', 'n', pickingColor);
      writeVertex(index, 2, label, rendered, 'p', 'p', pickingColor);
      writeVertex(index, 3, label, rendered, 'p', 'p', pickingColor);
      writeVertex(index, 4, label, rendered, 'n', 'p', pickingColor);
      writeVertex(index, 5, label, rendered, 'n', 'n', pickingColor);
    }
    function clearQuad(labelsByIndex, writeVertex, index) {
      writeQuad(labelsByIndex, writeVertex, index, {}, labelTextureManager.getInvisibleLabel(), NO_PICKING_COLOR);
    }
    var base = new GLFeatureLayers(gl, scheduler, gl.TRIANGLES, pickingColorAllocator, {
      VERTS_PER_INDEX: 6,  // TODO: use index buffers
      fragmentShader: ''
        + 'varying lowp vec3 v_texcoordAndOpacity;\n'
        + 'varying mediump vec4 v_pickingColor;\n'
        + 'uniform sampler2D labels;\n'
        + 'uniform bool picking;\n'
        + 'void main(void) {\n'
        + '  lowp vec2 texcoord = v_texcoordAndOpacity.xy;\n'
        + '  lowp float opacity = v_texcoordAndOpacity.z;\n'
        + '  gl_FragColor = picking ? v_pickingColor : opacity * texture2D(labels, texcoord);\n'
        + '  if ((picking ? v_texcoordAndOpacity.z : gl_FragColor.a) < 0.01) discard;'
        + '}\n',
      createLayer: function () {
        return {labelsByIndex: []};
      },
      beforeDraw: function (program) {
        labelTextureManager.writeTextureIfNeededAndLeaveBound();
        gl.uniform1i(gl.getUniformLocation(program, 'labels'), 0);
      },
      afterDraw: function () {
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      allocateFeature: function (array, indexFreeList, feature) {
        var iconIndex = indexFreeList.allocate();
        var textIndex = indexFreeList.allocate();
        //console.log('allocated feature', iconIndex, textIndex, feature);
        return {
          iconIndex: iconIndex,
          textIndex: textIndex
        };
      },
      deallocateFeature: function (layerState, writeVertex, indexFreeList, feature, info) {
        var labelsByIndex = layerState.labelsByIndex;
        //console.log('deallocated feature', feature);
        clearQuad(labelsByIndex, writeVertex, info.iconIndex);
        clearQuad(labelsByIndex, writeVertex, info.textIndex);
        indexFreeList.deallocate(info.iconIndex);
        indexFreeList.deallocate(info.textIndex);
      },
      updateFeatureRendering: function (layerState, dirty, indexFreeList, feature, writeVertex, info, renderer, pickingColor) {
        var labelsByIndex = layerState.labelsByIndex;
        var rendered = renderer(feature, dirty);
        if (rendered.position) {
          var iconURL = rendered.iconURL || '/client/map-icons/default.svg';
          var anchor = rendered.labelSide || 'top';
          var textLabel = labelTextureManager.refTextLabel(
            anchor === 'left' ? -1 : anchor === 'right' ? 1 : 0,
            anchor === 'left' ? -textRowHeight : anchor === 'right' ? textRowHeight : 0,
            anchor === 'bottom' ? -textRowHeight : anchor === 'top' ? textRowHeight : 0,
            rendered.label);
          var iconLabel = labelTextureManager.refIconLabel(0, 0, iconURL);
          var lat = rendered.position[0];
          var lon = rendered.position[1];
          var animated = rendered.speed > 0 && isFinite(rendered.vangle);
          writeQuad(labelsByIndex, writeVertex, info.iconIndex, rendered, iconLabel, pickingColor);
          writeQuad(labelsByIndex, writeVertex, info.textIndex, rendered, textLabel, pickingColor);
          textLabel.decRefCount();  // balance ref (now retained by writeQuad)
          iconLabel.decRefCount();  // ditto
          return animated;
        } else {
          clearQuad(labelsByIndex, writeVertex, info.iconIndex);
          clearQuad(labelsByIndex, writeVertex, info.textIndex);
          return false;
        }
      }
    });
    this.createLayer = base.createLayer.bind(base);
    this.program = base.program.bind(base);
  }

  function GLCurveLayers(gl, scheduler, pickingColorAllocator) {
    var dummyLabel = {
      tnx: 0,
      tpx: 0,
      tny: 0,
      tpy: 0,
      bnx: 0,
      bpx: 0,
      bny: 0,
      bpy: 0,
      bnz: 0,
      bpz: 0
    };
    
    var base = new GLFeatureLayers(gl, scheduler, gl.LINES, pickingColorAllocator, {
      VERTS_PER_INDEX: 2,
      fragmentShader: ''
        + 'varying lowp vec3 v_texcoordAndOpacity;\n'
        + 'varying mediump vec4 v_pickingColor;\n'
        + 'uniform sampler2D labels;\n'
        + 'uniform bool picking;\n'
        + 'void main(void) {\n'
        + '  lowp vec2 texcoord = v_texcoordAndOpacity.xy;\n'
        + '  lowp float opacity = v_texcoordAndOpacity.z;\n'
        + '  gl_FragColor = picking ? v_pickingColor : v_texcoordAndOpacity.z * vec4(0.0, 0.0, 0.0, 1.0);\n'
        + '}\n',
      createLayer: function () {
        return {};
      },
      beforeDraw: function (program) {
        gl.lineWidth(1);
      },
      afterDraw: function () {
        gl.lineWidth(1);  // reset
      },
      allocateFeature: function (array, indexFreeList, feature) {
        return {
          indices: []
        };
      },
      deallocateFeature: function (layerState, writeVertex, indexFreeList, feature, info) {
        var indices = info.indices;
        for (var i = 0; i < indices.length; i++) {
          var index = indices[i];
          writeVertex(index, 0, {}, {}, 'n', 'n', NO_PICKING_COLOR);
          writeVertex(index, 1, {}, {}, 'p', 'p', NO_PICKING_COLOR);
          indexFreeList.deallocate(index);
        }
      },
      updateFeatureRendering: function (layerState, dirty, indexFreeList, feature, writeVertex, info, renderer, pickingColor) {
        var indices = info.indices;
        var rendered = renderer(feature, dirty);
        var lineData = rendered.line;
        if (lineData == null) {
          lineData = [];
        }
        
        // allocate as needed
        while (indices.length < lineData.length) {
          indices.push(indexFreeList.allocate());
        }
        while (indices.length > lineData.length) {
          var index = indices.pop();
          writeVertex(index, 0, {}, {}, 'n', 'n', pickingColor);
          writeVertex(index, 1, {}, {}, 'p', 'p', pickingColor);
          indexFreeList.deallocate(index);
        }
        //console.log(rendered.label + ' adjusted to ' + indices.length);

        
        for (var i = 0; i < indices.length; i++) {
          var proxyPointA = {
            position: lineData[i]
          }
          if (i == lineData.length - 1) {
            var proxyPointB = rendered;
          } else {
            var proxyPointB = {
              position: lineData[i + 1]
            }
          }
          writeVertex(info.indices[i], 0, dummyLabel, proxyPointA, 'n', 'n', pickingColor);
          writeVertex(info.indices[i], 1, dummyLabel, proxyPointB, 'p', 'p', pickingColor);
        }
        return rendered.speed > 0 && isFinite(rendered.vangle);
      }
    });
    this.createLayer = base.createLayer.bind(base);
    this.program = base.program.bind(base);
  }

  // Not reusable, just a subdivision for sanity
  function MapCamera(scheduler, storage, redrawCallback, pickFromMouseEvent, positionedDevices, coordActions) {
    var w = 1;
    var h = 1;
    
    var viewCenterLat = storage && +(storage.getItem('viewCenterLat') || "NaN");
    var viewCenterLon = storage && +(storage.getItem('viewCenterLon') || "NaN");
    var viewZoom = storage && +(storage.getItem('viewZoom') || "NaN");
    if (!(isFinite(viewCenterLat) && isFinite(viewCenterLon) && viewZoom >= 1)) {
      // Saved coords are either nonexistent or invalid. Use a default.
      // TODO Use the device the user has actually selected. Be able to reset to this from the UI, too.
      var pd = positionedDevices.get()[0];
      if (pd) {
        viewCenterLat = +pd.track.get().latitude.value;
        viewCenterLon = +pd.track.get().longitude.value;
        viewZoom = 50;
      }
    }
    
    // If not null, a cell holding a Track object which we are locking the view to
    var trackingCell = null;
    
    // TODO: No standard cell class is suitable (write side effects, goes to storage, doesn't reparse on every read); fix.
    var latitudeCell = this.latitudeCell = new Cell(Number);
    this.latitudeCell.get = function () { return viewCenterLat; };
    this.latitudeCell.set = function (v) {
      if (viewCenterLat !== v) {
        viewCenterLat = v;
        changedView();
      }
    };
    var longitudeCell = this.longitudeCell = new Cell(Number);
    this.longitudeCell.get = function () { return viewCenterLon; };
    this.longitudeCell.set = function (v) {
      if (viewCenterLon !== v) {
        viewCenterLon = v;
        changedView();
      }
    };
    var zoomCell = this.zoomCell = new Cell(Number);
    this.zoomCell.get = function () { return viewZoom; };
    this.zoomCell.set = function (v) {
      if (viewZoom !== v) {
        viewZoom = v;
        changedView();
      }
    };
    
    function clampZoom() {
      // separated for use in implementing zoom-at-point
      viewZoom = Math.min(5000.0, Math.max(1.0, viewZoom));
    }
    function changedView() {
      // Recover from NaNs and non-numbers.
      if (!isFinite(viewCenterLat)) viewCenterLat = 0;
      if (!isFinite(viewCenterLon)) viewCenterLon = 0;
      if (!isFinite(viewZoom)) viewZoom = 1;
      
      // Clamp and normalize.
      viewCenterLat = Math.min(90, Math.max(-90, viewCenterLat));
      viewCenterLon = ((viewCenterLon + 180) % 360 + 360) % 360 - 180;
      clampZoom();
      
      // Save.
      if (storage) {
        storage.setItem('viewCenterLat', viewCenterLat);
        storage.setItem('viewCenterLon', viewCenterLon);
        storage.setItem('viewZoom', viewZoom);
      }
      
      //console.log(viewCenterLon, viewCenterLat, viewZoom);
      redrawCallback.scheduler.enqueue(redrawCallback);
      
      latitudeCell.n.notify();
      longitudeCell.n.notify();
      zoomCell.n.notify();
    }

    function getAngleScales() {
      // TODO: Should use scales based on what's under the cursor.
      var pixelsPerWholeSphere = Math.min(w, h) * viewZoom;
      var wholeSpherePerLinearDegrees = 0.5 * RADIANS_PER_DEGREE;
      var pixelsPerDegree = pixelsPerWholeSphere * wholeSpherePerLinearDegrees;

      return {
        x: 1 / -(pixelsPerDegree * Math.max(0.1, dcos(viewCenterLat))),
        y: 1 / pixelsPerDegree
      };
    }

    function drag(event) {
      trackingCell = null;  // cancel tracking
      
      // TODO: Should use scales based on what's under the cursor.
      var angleScales = getAngleScales();
      
      viewCenterLon += event.movementX * angleScales.x;
      viewCenterLat += event.movementY * angleScales.y;
      changedView();
      
      event.stopPropagation();
      event.preventDefault(); // no drag selection
    }
    
    this.addDragListeners = function addDragListeners(targetElement) {
      var viewChanger = {
        captureState: function () {
          return {
            lat: viewCenterLat,
            lon: viewCenterLon,
            zoom: viewZoom
          };
        },
        setState: function(state, grabDX, grabDY, nowDX, nowDY, dzoom) {
          trackingCell = null;  // cancel tracking
          
          viewZoom = state.zoom;
          var preAngleScales = getAngleScales();
          viewZoom = state.zoom * dzoom;  // done first to apply the change to scale
          clampZoom();
          var postAngleScales = getAngleScales();
          viewCenterLon = state.lon + grabDX * preAngleScales.x + nowDX * postAngleScales.x;
          viewCenterLat = state.lat + grabDY * preAngleScales.y + nowDY * postAngleScales.y;
          changedView();
        }
      };
      
      // pan and click
      // TOOD: duplicated code w/ other widgets, consider abstracting
      targetElement.addEventListener('mousedown', function(downEvent) {
        if (event.button !== 0) return;  // don't react to right-clicks etc.
        downEvent.preventDefault();
        document.addEventListener('mousemove', drag, true);
        document.addEventListener('mouseup', function upTemp(upEvent) {
          var delta = Math.hypot(upEvent.clientX - downEvent.clientX, upEvent.clientY - downEvent.clientY);
          if (delta < 5) {  // TODO justify slop
            var featureInfo = pickFromMouseEvent(downEvent);
            if (featureInfo) {
              featureInfo.clickOnFeature();
            }
          }
          document.removeEventListener('mousemove', drag, true);
          document.removeEventListener('mouseup', upTemp, true);
        }, true);
      }, false);

      // zoom
      // TODO: mousewheel event is allegedly nonstandard and inconsistent among browsers, notably not in Firefox (not that we're currently FF-compatible due to the socket issue).
      targetElement.addEventListener('mousewheel', function(event) {
        var rect = targetElement.getBoundingClientRect();
        var x = event.clientX - rect.left - rect.width / 2;
        var y = event.clientY - rect.top - rect.height / 2;
        viewChanger.setState(
          viewChanger.captureState(),
          -x,
          -y,
          x,
          y,
          Math.exp(event.wheelDeltaY * 0.0001))
      
        event.preventDefault();  // no scrolling
        event.stopPropagation();
      }, true);
      
      new TouchZoomHandler(targetElement, viewChanger, function tapHandler(touch, docX, docY) {
        var featureInfo = pickFromMouseEvent(touch);  // TODO undeclared type punning
        if (featureInfo) {
          featureInfo.clickOnFeature();
        }
      });
    };
    
    this.setSize = function setSize(newW, newH) {
      w = newW;
      h = newH;
      // no callback because currently this is called only when drawing. TODO refactor
    };
    
    this.getCameraMatrix = function getCameraMatrix() {
      var aspect = w / h;
      var scale = viewZoom;
      
      var projMat = new Float32Array([
        scale / (aspect > 1 ? aspect : 1), 0, 0, 0,
        0, scale * (aspect < 1 ? aspect : 1), 0, 0,
        0, 0, 1 /* no Z scale */, 1 /* translate so surface is 0,0,0 */,
        0, 0, 0, 1,
      ]);
      var lonRotMat = newMat4(); setRotMat(lonRotMat, 1, viewCenterLon * RADIANS_PER_DEGREE);
      var latRotMat = newMat4(); setRotMat(latRotMat, 0, -viewCenterLat * RADIANS_PER_DEGREE);
      var tmpRotMat = newMat4();
      var totalMat = newMat4();
      multMat(tmpRotMat, lonRotMat, latRotMat);
      multMat(totalMat, tmpRotMat, projMat);
      return totalMat;
    };
    
    // account for aspect ratio
    this.getEffectiveXZoom = function getEffectiveXZoom() {
      var aspect = w / h;
      return viewZoom / (aspect > 1 ? aspect : 1);
    };
    this.getEffectiveYZoom = function getEffectiveYZoom() {
      var aspect = w / h;
      return viewZoom * (aspect < 1 ? aspect : 1);
    };
    
    // tracking
    function updateFromCell() {
      if (trackingCell == null) return;
      var track = trackingCell.depend(updateFromCell);
      viewCenterLat = track.latitude.value;
      viewCenterLon = track.longitude.value;
      // TODO initial zoom, interpolation, possible absence of actual lat/lon values
      changedView();
    }
    updateFromCell.scheduler = scheduler;
    
    coordActions._registerMap(function navigateMapCallback(trackCell) {
      trackingCell = trackCell;
      updateFromCell();
    });
    
    changedView();
  }

  function GeoMap(config) {
    var containerElement = this.element = config.element;
    var scheduler = config.scheduler;
    var db = config.freqDB;
    var radioCell = config.target;
    var storage = config.storage;
    
    containerElement.textContent = '';  // clear
    containerElement.classList.add('map-container');

    var canvas = document.createElement('canvas');
    canvas.classList.add('map-canvas');
    
    // Abort if we can't do GL.
    var gl = gltools.getGL(config, canvas, {
      alpha: true,
      depth: true,  // TODO revisit if we end up using it
      stencil: false,
      antialias: false,  // TODO revisit
      preserveDrawingBuffer: false
    });
    if (!gl) {
      var filler = containerElement.appendChild(document.createElement('div'));
      createWidgetExt(config.context, Banner, filler, new ConstantCell(String, 'Sorry, the map requires WebGL to be supported and enabled.'));
      return;
    }
    containerElement.appendChild(canvas);
    
    // --- Non-GL UI ---
    
    var coordinateDisplay = containerElement.appendChild(document.createElement('form'));
    coordinateDisplay.classList.add('map-coordinate-control');
    // filled later
    
    var layerSwitcherContainer = containerElement.appendChild(document.createElement('details'));
    layerSwitcherContainer.classList.add('map-layer-switcher');
    layerSwitcherContainer.appendChild(document.createElement('summary')).textContent = 'Layers';
    
    // --- Start initializing GL stuff --
    
    gltools.handleContextLoss(canvas, config.rebuildMe);
    
    gl.enable(gl.CULL_FACE);
    
    // Framebuffer used for picking
    var pickFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
    // create and attach color texture (renderbuffer isn't guaranteed)
    var pickColorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pickColorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickColorTexture, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // skip gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    // create and attach depth renderbuffer
    var pickDepthRenderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepthRenderbuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepthRenderbuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    // set storage size
    function updateRenderbufferSize() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepthRenderbuffer);
      gl.bindTexture(gl.TEXTURE_2D, pickColorTexture);

      var width = gl.drawingBufferWidth || 1;
      var height = gl.drawingBufferHeight || 1;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);

      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    updateRenderbufferSize();
    
    
    var draw = config.boundedFn(function drawImpl() {
      var w, h;
      // Fit current layout
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        // implicitly clears
        canvas.width = w;
        canvas.height = h;
        updateRenderbufferSize();
      }
      gl.viewport(0, 0, w, h);
      mapCamera.setSize(w, h);
      
      var cameraMatrix = mapCamera.getCameraMatrix();

      gl.clearColor(0.5, 0.5, 0.5, 1);  // TODO justify color
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(sphere.program());
      gl.uniformMatrix4fv(gl.getUniformLocation(sphere.program(), 'projection'), false, cameraMatrix);
      sphere.draw();

      function drawVisibleLayers(type, picking) {
        layers.forEach(function (layerInt, layerExt) {
          if (layerInt.visibility.depend(draw)) {
            layerInt[type].draw(picking);
          }
        });
      }
      
      gl.enable(gl.DEPTH_TEST);
      
      gl.useProgram(curves.program());
      gl.uniformMatrix4fv(gl.getUniformLocation(curves.program(), 'projection'), false, cameraMatrix);
      drawVisibleLayers('glDrawCurves', false);
      
      gl.useProgram(points.program());
      gl.uniformMatrix4fv(gl.getUniformLocation(points.program(), 'projection'), false, cameraMatrix);
      drawVisibleLayers('glDrawPoints', false);

      // leave depth test on for picking
      
      // pick buffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
      gl.viewport(0, 0, w, h);
      // Color reserved for no-target because it's also the color we get if we read out of bounds.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(points.program());
      drawVisibleLayers('glDrawPoints', true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      
      gl.disable(gl.DEPTH_TEST);
    });
    draw.scheduler = scheduler;
    window.addEventListener('resize', function (event) {
      // immediate to ensure smooth animation
      scheduler.callNow(draw);
    });
    
    var mapCamera = new MapCamera(scheduler, storage, draw, pickFromMouseEvent, config.index.implementing('shinysdr.devices.IPositionedDevice'), config.actions);
    // TODO: Once we have overlays, put the listeners on the overlay container...?
    mapCamera.addDragListeners(canvas);
    
    var pickingColorAllocatorBase = new FreeListAllocator(1, function() {});
    pickingColorAllocatorBase.allocate();  // reserve 0 == NO_PICKING_COLOR for not-an-object
    var pickingObjects = [null];
    var pickingColorAllocator = {
      allocate: function () {
        var index = pickingColorAllocatorBase.allocate();
        var dead = false;
        return {
          index: index,
          assign: function assign(object) {
            if (dead) {
              throw new Error('dead picking allocation');
            }
            pickingObjects[index] = object;
          },
          _die: function () {
            dead = true;
          }
        };
      },
      deallocate: function (allocation) {
        allocation._die();
      }
    };
    
    function pickFromMouseEvent(event) {
      var localX = event.clientX - canvas.getBoundingClientRect().left;
      var localY = -(event.clientY - canvas.getBoundingClientRect().bottom);
      var array = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
      gl.readPixels(localX, localY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, array);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      var unpacked = array[0] + (array[1] << 8) + (array[2] << 16) + (array[3] << 24);
      var featureInfo = pickingObjects[unpacked];
      if (featureInfo) {
        console.log(localX, localY, array, unpacked, featureInfo.feature);
      }
      return featureInfo;
    }
    
    var sphere = new GLSphere(gl, draw);
    var points = new GLPointLayers(gl, scheduler, draw, pickingColorAllocator);
    var curves = new GLCurveLayers(gl, scheduler, pickingColorAllocator);
    var layers = new Map();
    
    function addLayer(label, lconfig) {
      // TODO: type-check the contents
      label = String(label);
      var featuresCell = lconfig.featuresCell;
      var featureRenderer = lconfig.featureRenderer;
      var clickHandler = lconfig.onclick || function noClick() {};
      // TODO: Instead of a "clickHandler" we should have a more general presentation-style system
      var controlsCell = new ConstantCell(block, lconfig.controls || makeBlock({}));
      
      var visibilityCell = new StorageCell(storage, Boolean, true, 'layer-visible.' + label);
      
      function redrawLayer() {
        if (visibilityCell.get()) {
          draw.scheduler.enqueue(draw);
        }
      }
      redrawLayer.scheduler = scheduler;
      
      var layerInt = {
        glDrawPoints: points.createLayer(featuresCell, featureRenderer, clickHandler, redrawLayer),
        glDrawCurves: curves.createLayer(featuresCell, featureRenderer, clickHandler, redrawLayer),
        visibility: visibilityCell,
      };
      var layerExt = {};
      layers.set(layerExt, layerInt);
      
      var checkboxOuter = layerSwitcherContainer.appendChild(document.createElement('label'));
      var checkbox = checkboxOuter.appendChild(document.createElement('input'));
      checkbox.type = 'checkbox';
      checkboxOuter.appendChild(document.createTextNode(label));
      createWidgetExt(config.context, Toggle, checkbox, visibilityCell);
      var controlsOuter = layerSwitcherContainer.appendChild(document.createElement('div'));
      var controlsInner = controlsOuter.appendChild(document.createElement('div'));
      createWidgetExt(config.context, PickBlock, controlsInner, controlsCell);
      
      function layerControlsVisibilityHook() {
        controlsOuter.style.display = visibilityCell.depend(layerControlsVisibilityHook) ? 'block' : 'none';
      }
      layerControlsVisibilityHook.scheduler = scheduler;
      layerControlsVisibilityHook();
      
      scheduler.enqueue(draw);
      return layerExt;
    }
    
    // --- Late UI setup ---
    
    // TODO: Use custom widgets which intelligently format # of digits and step size
    createWidgetExt(config.context, SmallKnob, coordinateDisplay.appendChild(document.createElement('div')), mapCamera.latitudeCell);
    createWidgetExt(config.context, SmallKnob, coordinateDisplay.appendChild(document.createElement('div')), mapCamera.longitudeCell);
    createWidgetExt(config.context, SmallKnob, coordinateDisplay.appendChild(document.createElement('div')), mapCamera.zoomCell);
    
    // --- Done with rendering setup, now data logic. TODO Split.
    
    // Receiver-derived data
    // TODO: Clunky. Revisit interface
    function addModeLayer(filterMode, renderer) {
      if (arguments.length !== 2) {
        throw new Error('wrong call to addModeLayer');
      }
      var receiversCell = new DerivedCell(any, scheduler, function (dirty) {
        var radio = radioCell.depend(dirty);
        var receivers = radio.receivers.depend(dirty);
        receivers._reshapeNotice.listen(dirty);
        var out = [];
        for (var key in receivers) {
          var receiver = receivers[key].depend(dirty);
          if (receiver.mode.depend(dirty) === filterMode) {
            out.push(receiver);
          }
        }
        return out;
      });
      // TODO once clicking/etc is more thought out allow it here
      addLayer(filterMode, {
        featuresCell: receiversCell,
        featureRenderer: renderer
      });
    }
    
    // TODO provide an actually designed and sensible interface which is less export-our-stuff-for-them-to-go-wild-with.
    var mapPluginConfig = Object.freeze({
      db: db,
      scheduler: scheduler,
      index: config.index,
      addLayer: addLayer,
      addModeLayer: addModeLayer,
      storage: storage,  // TODO drop this or give it a namespace
      radioCell: radioCell,  // TODO: let the layers get their own data, somehow
      mapCamera: mapCamera,  // TODO: provide a read-only or otherwise appropriately designed facet
      actions: config.actions
    });
    plugins.forEach(function(pluginFunc) {
      pluginFunc(mapPluginConfig);
    });
  }
  exports.GeoMap = GeoMap;
  
  var plugins = [];
  exports.register = function(pluginFunc) {
    plugins.push(pluginFunc);
  };
  
  // TODO: Instead of making this global state, make track-valued cells keep the histories.
  var trackPositionHistories = new WeakMap();
  
  function renderTrackFeature(dirty, trackCell, label) {
    var history = trackPositionHistories.get(trackCell);
    if (!history) {
      trackPositionHistories.set(trackCell, history = []);
    }
    if (history.length > 1000) {  // TODO better implementation
      history = history.slice(500);
    }
    var lastHistory = history[history.length - 1] || [null, null];
    
    var track = trackCell.depend(dirty);
    var lat = track.latitude.value;
    var lon = track.longitude.value;
    var position;
    if (!(typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon))) {
      position = null;
    } else {
      position = [lat, lon];
    }
    
    if (position && (!lastHistory || (position[0] != lastHistory[0] && position[1] != lastHistory[1]))) {
      history.push(position);
    }
    
    return {
      timestamp: track.longitude.timestamp,  // TODO verify other values match
      label: label,
      position: position,
      vangle: track.track_angle.value,
      speed: track.h_speed.value || 0,
      line: history
    };
  }
  exports.renderTrackFeature = renderTrackFeature;
  
  return Object.freeze(exports);
});