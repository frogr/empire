// Optional CRT post-pass (PRD §3.2, M4 polish): barrel curvature, scanlines,
// slight chroma fringe, vignette. Off by default; F10 toggles. When enabled,
// the 2D canvas is hidden and each frame is uploaded as a texture.

const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  uv *= 1.0 + 0.042 * dot(uv, uv);
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float fringe = 0.0009;
  float r = texture2D(uTex, uv + vec2(fringe, 0.0)).r;
  float g = texture2D(uTex, uv).g;
  float b = texture2D(uTex, uv - vec2(fringe, 0.0)).b;
  vec3 col = vec3(r, g, b);
  float scan = sin(uv.y * uRes.y * 3.14159) * 0.5 + 0.5;
  col *= 0.92 + 0.08 * scan;
  vec2 c = uv - 0.5;
  col *= 1.0 - dot(c, c) * 0.55;
  col += col * 0.04 * sin(uv.y * uRes.y * 6.28318);
  gl_FragColor = vec4(col, 1.0);
}`;

export class CrtPass {
  private overlay: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private uRes: WebGLUniformLocation | null = null;
  enabled = false;

  constructor(private source: HTMLCanvasElement) {
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:none;pointer-events:none;';
    document.body.appendChild(this.overlay);
    const gl = this.overlay.getContext('webgl', { antialias: false, depth: false });
    if (!gl) return;
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.uRes = gl.getUniformLocation(prog, 'uRes');
  }

  setEnabled(on: boolean): void {
    if (!this.gl) return;
    this.enabled = on;
    this.overlay.style.display = on ? 'block' : 'none';
    this.source.style.visibility = on ? 'hidden' : 'visible';
  }

  render(): void {
    const gl = this.gl;
    if (!gl || !this.enabled) return;
    if (this.overlay.width !== this.source.width || this.overlay.height !== this.source.height) {
      this.overlay.width = this.source.width;
      this.overlay.height = this.source.height;
      gl.viewport(0, 0, this.overlay.width, this.overlay.height);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
    gl.uniform2f(this.uRes, this.overlay.width, this.overlay.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
