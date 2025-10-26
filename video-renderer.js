// From https://github.com/w3c/webcodecs/tree/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/video-decode-display
// in files render_2d, render_webgl, render_webgpu

class WebGLRenderer {
  #canvas = null;
  #ctx = null;

  static vertexShaderSource = `
    attribute vec2 xy;

    varying highp vec2 uv;

    void main(void) {
      gl_Position = vec4(xy, 0.0, 1.0);
      // Map vertex coordinates (-1 to +1) to UV coordinates (0 to 1).
      // UV coordinates are Y-flipped relative to vertex coordinates.
      uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0);
    }
  `;

  static fragmentShaderSource = `
    varying highp vec2 uv;

    uniform sampler2D texture;

    void main(void) {
      gl_FragColor = texture2D(texture, uv);
    }
  `;

  constructor(canvas, type = "webgl2") {
    this.#canvas = canvas;
    const gl = (this.#ctx = canvas.getContext(type));

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, WebGLRenderer.vertexShaderSource);
    gl.compileShader(vertexShader);
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      throw gl.getShaderInfoLog(vertexShader);
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, WebGLRenderer.fragmentShaderSource);
    gl.compileShader(fragmentShader);
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      throw gl.getShaderInfoLog(fragmentShader);
    }

    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      throw gl.getProgramInfoLog(shaderProgram);
    }
    gl.useProgram(shaderProgram);

    // Vertex coordinates, clockwise from bottom-left.
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1.0, -1.0, -1.0, +1.0, +1.0, +1.0, +1.0, -1.0]),
      gl.STATIC_DRAW,
    );

    const xyLocation = gl.getAttribLocation(shaderProgram, "xy");
    gl.vertexAttribPointer(xyLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(xyLocation);

    // Create one texture to upload frames to.
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  draw(frame) {
    this.#canvas.width = frame.displayWidth;
    this.#canvas.height = frame.displayHeight;

    const gl = this.#ctx;

    // Upload the frame.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    // Configure and clear the drawing area.
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(1.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Draw the frame.
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }
}

class WebGPURenderer {
  #canvas = null;
  #ctx = null;

  // Promise for `#start()`, WebGPU setup is asynchronous.
  #started = null;

  // WebGPU state shared between setup and drawing.
  #format = null;
  #device = null;
  #pipeline = null;
  #sampler = null;

  // Generates two triangles covering the whole canvas.
  static vertexShaderSource = `
    struct VertexOutput {
      @builtin(position) Position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    }

    @vertex
    fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
      var pos = array<vec2<f32>, 6>(
        vec2<f32>( 1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(-1.0,  1.0)
      );

      var uv = array<vec2<f32>, 6>(
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 0.0)
      );

      var output : VertexOutput;
      output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
      output.uv = uv[VertexIndex];
      return output;
    }
  `;

  // Samples the external texture using generated UVs.
  static fragmentShaderSource = `
    @group(0) @binding(1) var mySampler: sampler;
    @group(0) @binding(2) var myTexture: texture_external;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
    }
  `;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#started = this.#start();
  }

  async #start() {
    const adapter = await navigator.gpu.requestAdapter();
    this.#device = await adapter.requestDevice();
    this.#format = navigator.gpu.getPreferredCanvasFormat();

    this.#ctx = this.#canvas.getContext("webgpu");
    this.#ctx.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.#device.createShaderModule({
          code: WebGPURenderer.vertexShaderSource,
        }),
        entryPoint: "vert_main",
      },
      fragment: {
        module: this.#device.createShaderModule({
          code: WebGPURenderer.fragmentShaderSource,
        }),
        entryPoint: "frag_main",
        targets: [{ format: this.#format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // Default sampler configuration is nearset + clamp.
    this.#sampler = this.#device.createSampler({});
  }

  async draw(frame) {
    // Don't try to draw any frames until the context is configured.
    await this.#started;

    this.#canvas.width = frame.displayWidth;
    this.#canvas.height = frame.displayHeight;

    const uniformBindGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: this.#sampler },
        {
          binding: 2,
          resource: this.#device.importExternalTexture({ source: frame }),
        },
      ],
    });

    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: [1.0, 0.0, 0.0, 1.0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#pipeline);
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }
}

class Canvas2DRenderer {
  #canvas = null;
  #ctx = null;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
  }

  draw(frame) {
    this.#canvas.width = frame.displayWidth;
    this.#canvas.height = frame.displayHeight;
    this.#ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
  }
}

export { WebGLRenderer, WebGPURenderer, Canvas2DRenderer };
