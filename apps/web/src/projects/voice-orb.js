// A compact voice adaptation of the accepted refractive idea orb.
// The caller supplies the live analyser level; silence never gets a fake pulse.
export function mountVoiceOrb(
  canvas,
  getAudioLevel = () => 0,
  onReady = () => {},
) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  if (!gl) {
    queueMicrotask(onReady);
    return () => {};
  }
  const vertex = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`;
  const fragment = `precision highp float;
 uniform vec2 resolution;
 uniform float time;
 uniform float audioLevel;
 uniform sampler2D skyTexture;
 uniform vec2 viewport;
 uniform vec4 orbRect;
 vec3 sky(vec2 uv){
  float ratio=(viewport.x/viewport.y)/(1672./941.);
  vec2 crop=ratio>1.?vec2(1.,1./ratio):vec2(ratio,1.);
  vec2 sampleUV=(clamp(uv,0.,1.)-.5)*crop+.5;
  return mix(texture2D(skyTexture,sampleUV).rgb,vec3(1.,.99,.97),.10);
 }
 float mainRadius(){return .94+audioLevel*.045*sin(time*2.1);}
 float body(vec3 p){
  float voiceWave=sin(p.x*3.2+time*.7)*sin(p.y*2.8-time*.5)*sin(p.z*3.1+time*.43);
  float d=length(p)-mainRadius()-voiceWave*(.025+audioLevel*.075);
  return d;
 }
 vec3 normalAt(vec3 p){vec2 e=vec2(.002,0.);return normalize(vec3(body(p+e.xyy)-body(p-e.xyy),body(p+e.yxy)-body(p-e.yxy),body(p+e.yyx)-body(p-e.yyx)));}
 void main(){
  vec2 uv=(gl_FragCoord.xy-.5*resolution)/resolution.y*2.65;
  vec3 p=vec3(uv,2.4);
  float travel=0.;
  for(int i=0;i<44;i++){float d=body(p);if(d<.001||travel>4.)break;travel+=d*.82;p.z-=d*.82;}
  if(travel>4.){gl_FragColor=vec4(0.);return;}
  vec3 n=normalAt(p);
  // Local material coordinates let the live level shape the luminous fold.
  vec3 local=p/mainRadius()*.94;
  float t=time*.65;
  float turn=t*.3;
  vec3 q=vec3(cos(turn)*local.x+sin(turn)*local.z,local.y,-sin(turn)*local.x+cos(turn)*local.z);
  float fold=q.y+.23*sin(q.x*3.2+t)+.14*sin(q.z*3.6-t*.7);
  // A clear lens with a broad, rounded bevel rather than a soap-bubble rim.
  vec2 screenUV=(orbRect.xy+(gl_FragCoord.xy/resolution)*orbRect.zw)/viewport;
  vec2 lensScale=vec2(orbRect.w)/viewport;
  float radial=length(n.xy);
  float bevel=smoothstep(.72,.998,radial);
  vec3 lensNormal=normalize(vec3(n.xy*bevel, max(.06,1.-bevel)));
  vec3 ray=refract(vec3(0.,0.,-1.),lensNormal,1./1.46);
  vec2 bent=screenUV+ray.xy*lensScale*.30;
  vec3 transmission=sky(bent);
  vec3 color=transmission;
  // Background compression at the curved perimeter gives the glass thickness.
  vec2 direction=normalize(n.xy+vec2(.0001));
  float key=dot(direction,normalize(vec2(-.65,.76)));
  float upperLight=pow(max(key,0.),3.);
  float lowerLight=pow(max(-key,0.),7.);
  float shoulder=exp(-pow((radial-.94)*15.,2.));
  float outerEdge=smoothstep(.982,1.,radial);
  float innerEdge=exp(-pow((radial-.984)*85.,2.));
  // Neutral occlusion and paired edge lights: no blue glaze or white surface spot.
  float shade=(.035+.11*pow(max(direction.x,0.),2.))*shoulder;
  color*=1.-shade;
  color=mix(color,vec3(1.),shoulder*(upperLight*.35+lowerLight*.12));
  color=mix(color,vec3(1.),outerEdge*(upperLight*.62+lowerLight*.42+.04));
  color*=1.-innerEdge*.11*(1.-upperLight);
  // The luminous fold is suspended inside, leaving the clear bevel unobstructed.
  float depth=1.-smoothstep(.64,.89,length(local.xy));
  vec3 ink=mix(vec3(.12,.34,.98),vec3(.67,.28,.96),smoothstep(-.8,.8,q.x));
  float core=1.-smoothstep(.08,.24,abs(fold));
  float halo=exp(-pow(fold*5.5,2.));
  color=mix(color,ink,core*.80*depth);
  color+=vec3(.19,.15,.34)*halo*.14*depth;
  float shining=exp(-pow((fold-.19)*12.,2.));
  color+=mix(vec3(.45,.62,1.),vec3(1.,.48,.81),smoothstep(-.7,.6,q.x))*shining*.27*depth;
  // Audio changes the inner light and the surface deformation together.
  color+=vec3(.22,.28,.54)*audioLevel*halo*.22*depth;
  // Keep transparent pixels premultiplied so CSS blur cannot expose bright RGB.
  gl_FragColor=vec4(clamp(color,0.,1.),1.);
 }`;
  let program,
    buffer,
    texture,
    skyImage,
    frame = 0,
    dead = false;
  const shaders = [];
  const cleanup = () => {
    dead = true;
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", visibility);
    canvas.removeEventListener("webglcontextlost", lost);
    if (skyImage) {
      skyImage.onload = null;
      skyImage.onerror = null;
    }
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((s) => gl.deleteShader(s));
  };
  function shader(type, source) {
    const s = gl.createShader(type);
    shaders.push(s);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw Error("Orb shader unavailable");
    return s;
  }
  function lost(event) {
    event.preventDefault();
    canvas.parentElement.dataset.renderer = "fallback";
    cleanup();
  }
  let draw = () => {},
    start = 0;
  function visibility() {
    cancelAnimationFrame(frame);
    if (!document.hidden && !dead && start) frame = requestAnimationFrame(draw);
  }
  try {
    program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error("Orb material unavailable");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const pos = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const clock = gl.getUniformLocation(program, "time"),
      audio = gl.getUniformLocation(program, "audioLevel"),
      size = gl.getUniformLocation(program, "resolution");
    const viewportLocation = gl.getUniformLocation(program, "viewport"),
      rectLocation = gl.getUniformLocation(program, "orbRect");
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([173, 198, 225]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "skyTexture"), 0);
    skyImage = new Image();
    skyImage.onload = () => {
      if (dead) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB,
        gl.RGB,
        gl.UNSIGNED_BYTE,
        skyImage,
      );
      canvas.parentElement.dataset.environment = "reverie";
      start = performance.now();
      frame = requestAnimationFrame(draw);
    };
    skyImage.onerror = () => {
      cleanup();
      onReady();
    };
    const scale = Math.min(1.5, 820 / canvas.parentElement.clientWidth);
    const width = Math.round(canvas.parentElement.clientWidth * scale),
      height = Math.round(canvas.parentElement.clientHeight * scale);
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(size, width, height);
    let ready = false;
    draw = (now) => {
      if (dead) return;
      let level = 0;
      try {
        level = Math.max(0, Math.min(1, Number(getAudioLevel()) || 0));
      } catch {
        level = 0;
      }
      gl.uniform1f(audio, level);
      const r = canvas.getBoundingClientRect();
      gl.uniform2f(viewportLocation, innerWidth, innerHeight);
      gl.uniform4f(
        rectLocation,
        r.left,
        innerHeight - r.bottom,
        r.width,
        r.height,
      );
      gl.uniform1f(clock, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!ready) {
        ready = true;
        canvas.parentElement.dataset.renderer = "webgl";
        onReady();
      }
      frame = requestAnimationFrame(draw);
    };
    canvas.addEventListener("webglcontextlost", lost);
    document.addEventListener("visibilitychange", visibility);
    skyImage.src = "/art/reverie-v1.webp";
  } catch {
    cleanup();
    queueMicrotask(onReady);
  }
  return cleanup;
}
