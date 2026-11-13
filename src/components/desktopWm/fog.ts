/**
 * The fog behind the desktop: the same WebGL shader as the author's site, drawn at half the
 * resolution and only while the desktop is shown and the tab is visible. Without WebGL a few
 * soft 2D gradients drift in its place.
 */

const VERTEX_SHADER = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(0.80, 0.60, -0.60, 0.80) * 2.03;
  for(int i = 0; i < 5; i++){ v += a * noise(p); p = m * p; a *= 0.48; }
  return v / 0.97;
}
void main(){
  vec2 st = gl_FragCoord.xy / u_res.y;
  float aspect = u_res.x / u_res.y;
  float t = u_time;

  vec2 uvA = st * 0.85 + vec2( t * 0.10,  t * 0.03);
  vec2 uvB = st * 1.45 + vec2(-t * 0.14,  t * 0.05) + 11.3;
  vec2 uvC = st * 2.60 + vec2( t * 0.07, -t * 0.09) + 27.1;

  float a = fbm(uvA);
  float b = fbm(uvB + a * 0.45);
  float c = fbm(uvC);

  float layer1 = smoothstep(0.32, 0.60, a);
  float layer2 = smoothstep(0.32, 0.60, b);
  float layer3 = smoothstep(0.32, 0.60, c);

  float dens = layer1 * 0.60 + layer2 * 0.45 + layer3 * 0.25;
  dens *= 0.80 + 0.35 * (1.0 - st.y);
  dens = clamp(dens, 0.0, 1.0);

  vec3 bg = mix(vec3(0.700, 0.740, 0.780), vec3(0.780, 0.810, 0.840), clamp(st.y, 0.0, 1.0));
  vec3 col = mix(bg, vec3(1.0), dens * 0.90);

  vec2 cc = st / vec2(aspect, 1.0) - 0.5;
  col += (1.0 - smoothstep(0.0, 0.75, length(cc))) * 0.03;
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) / 220.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// * the fog is soft, so a quarter of the pixels draw it as well as all of them
const RESOLUTION_SCALE = 0.5;

export default class Fog {
  private gl: WebGLRenderingContext;
  private ctx2d: CanvasRenderingContext2D;
  private uniforms: {res: WebGLUniformLocation, time: WebGLUniformLocation} = {} as any;
  private time = 0;
  private lastFrame = 0;
  private frameId = 0;
  private running = false;
  private reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  constructor(public readonly canvas: HTMLCanvasElement) {
    if(!this.initGL()) {
      this.ctx2d = canvas.getContext('2d');
    }

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize();
  }

  private initGL() {
    let gl: WebGLRenderingContext;
    try {
      gl = this.canvas.getContext('webgl', {antialias: false, alpha: false, powerPreference: 'low-power'});
    } catch(err) {}

    if(!gl) {
      return false;
    }

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if(!vertex || !fragment) {
      return false;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return false;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    // * one triangle that covers the whole canvas
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    this.uniforms.res = gl.getUniformLocation(program, 'u_res');
    this.uniforms.time = gl.getUniformLocation(program, 'u_time');
    this.gl = gl;
    return true;
  }

  private resize = () => {
    const {canvas} = this;
    canvas.width = Math.max(2, Math.floor(window.innerWidth * RESOLUTION_SCALE));
    canvas.height = Math.max(2, Math.floor(window.innerHeight * RESOLUTION_SCALE));
    this.gl?.viewport(0, 0, canvas.width, canvas.height);
    // * a canvas that was resized is empty until the next frame, which a stopped fog would not draw
    this.running || this.draw(0);
  };

  private onVisibilityChange = () => {
    if(document.hidden) {
      this.cancelFrame();
    } else if(this.running) {
      this.lastFrame = performance.now();
      this.requestFrame();
    }
  };

  private requestFrame() {
    this.cancelFrame();
    this.frameId = requestAnimationFrame(this.frame);
  }

  private cancelFrame() {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.draw(dt);
    this.frameId = requestAnimationFrame(this.frame);
  };

  private draw(dt: number) {
    this.time += dt * (this.reduceMotion ? 0.05 : 1);
    const {canvas, gl} = this;
    if(gl) {
      gl.uniform2f(this.uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(this.uniforms.time, this.time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }

    const {ctx2d: ctx} = this;
    const {width, height} = canvas;
    ctx.fillStyle = '#cdd3da';
    ctx.fillRect(0, 0, width, height);
    for(let i = 0; i < 10; ++i) {
      const angle = this.time * 0.15 * (0.6 + i * 0.06) + i * 1.9;
      const x = width * (0.5 + 0.5 * Math.sin(angle + i));
      const y = height * (0.5 + 0.42 * Math.cos(angle * 0.8 + i * 2));
      const radius = Math.max(width, height) * (0.30 + 0.1 * Math.sin(angle * 1.3 + i));
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, 'rgba(255, 255, 255, .45)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  public start() {
    if(this.running) {
      return;
    }

    this.running = true;
    this.lastFrame = performance.now();
    document.hidden || this.requestFrame();
  }

  public stop() {
    this.running = false;
    this.cancelFrame();
  }
}
