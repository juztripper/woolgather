export const SHAPING_TIMING = {
  first: 1700,
  second: 3900,
  settled: 6100,
  complete: 7400,
  third: 6100,
  longSettled: 8300,
  longComplete: 9600,
};
// Refractive 3D material using the same Reverie sky as the surrounding screen.
export function mountIdeaOrb(
  canvas,
  onReady = () => {},
  { extended = false } = {},
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
 uniform float formCount;
 uniform float departureTime;
 uniform sampler2D skyTexture;
 uniform vec2 viewport;
 uniform vec4 orbRect;
 vec3 sky(vec2 uv){
  float ratio=(viewport.x/viewport.y)/(1672./941.);
  vec2 crop=ratio>1.?vec2(1.,1./ratio):vec2(ratio,1.);
  vec2 sampleUV=(clamp(uv,0.,1.)-.5)*crop+.5;
  return mix(texture2D(skyTexture,sampleUV).rgb,vec3(1.,.99,.97),.10);
 }
 // A lightly damped glide: continuous velocity, a small overshoot, then a long settle.
 float glide(float began){float t=max(0.,time-began);return 1.-exp(-1.9*t)*(cos(1.75*t)+(1.9/1.75)*sin(1.75*t));}
 float releaseA(){return smoothstep(${SHAPING_TIMING.first / 1000},${SHAPING_TIMING.second / 1000},time);}
 float releaseB(){return smoothstep(${SHAPING_TIMING.second / 1000},${SHAPING_TIMING.settled / 1000},time);}
 float releaseC(){return smoothstep(${SHAPING_TIMING.third / 1000},${SHAPING_TIMING.longSettled / 1000},time);}
 vec3 childC(){float s=glide(${SHAPING_TIMING.third / 1000});return vec3(.78*s+.04*s*sin(time*.8),.98*s+.045*s*cos(time*.7),0.);}
 float radiusC(){return .23*smoothstep(5.7,7.1,time);}
 float distanceC(vec3 p){return length(p-childC())-radiusC();}
 float separation(){return (releaseA()+releaseB())*.5;}
 vec3 childA(){float s=glide(${SHAPING_TIMING.first / 1000});return vec3(-1.70*s+.075*s*sin(time*.8),.45*s+.10*s*sin(time*.95+1.),.06*s*sin(time*.6));}
 vec3 childB(){float s=glide(${SHAPING_TIMING.second / 1000});return vec3(1.64*s+.085*s*sin(time*.7+2.),-.34*s+.11*s*sin(time*.85+3.),.05*s*cos(time*.7));}
 float radiusA(){return .40*smoothstep(${(SHAPING_TIMING.first - 400) / 1000},${(SHAPING_TIMING.first + 1000) / 1000},time);}
 float radiusB(){return .36*smoothstep(${(SHAPING_TIMING.second - 400) / 1000},${(SHAPING_TIMING.second + 1000) / 1000},time);}
 vec3 axesA(){float s=releaseA();return vec3(1.-.07*s+.045*s*sin(time*.9),1.+.08*s-.04*s*sin(time*.9),1.);}
 vec3 axesB(){float s=releaseB();return vec3(1.+.09*s+.035*s*cos(time*.8),1.-.07*s-.03*s*cos(time*.8),1.);}
 float distanceA(vec3 p){return (length((p-childA())/axesA())-radiusA())*.88;}
 float distanceB(vec3 p){return (length((p-childB())/axesB())-radiusB())*.88;}
 float unionSoft(float a,float b){float k=.32;float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}
 float mainRadius(){return .94*(1.-.10*separation()*step(1.5,formCount));}
 float body(vec3 p){
  float wave=sin(p.x*2.8+time*.65)*sin(p.y*2.5-time*.48)*sin(p.z*2.6+time*.4);
  float d=length(p)-mainRadius()-wave*.035;
  if(formCount>1.5)d=unionSoft(d,distanceA(p));
  if(formCount>2.5)d=unionSoft(d,distanceB(p));
  if(formCount>3.5)d=unionSoft(d,distanceC(p));
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
  // Local material coordinates let each released idea carry its own inner light.
  vec3 local=p/mainRadius()*.94;
  float nearest=length(p)-mainRadius();
  float identity=0.;
  float ra=max(.01,radiusA()),rb=max(.01,radiusB());
  if(formCount>1.5){float d=distanceA(p);float blend=1.-smoothstep(-.14,.14,d-nearest);identity=mix(identity,1.,blend);local=mix(local,(p-childA())/axesA()/ra*.94,blend);nearest=min(nearest,d);}
  if(formCount>2.5){float d=distanceB(p);float blend=1.-smoothstep(-.14,.14,d-nearest);identity=mix(identity,2.,blend);local=mix(local,(p-childB())/axesB()/rb*.94,blend);nearest=min(nearest,d);}
  if(formCount>3.5){float d=distanceC(p);float blend=1.-smoothstep(-.14,.14,d-nearest);identity=mix(identity,3.,blend);local=mix(local,(p-childC())/max(.01,radiusC())*.94,blend);}
  float t=time*(.65+identity*.09)+identity*2.1;
  float turn=t*.3+identity*.65;
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
  vec3 childInk=mix(vec3(.22,.65,.78),vec3(.44,.50,.95),smoothstep(-.8,.8,q.x));
  vec3 warmInk=mix(vec3(.87,.48,.49),vec3(.73,.46,.83),smoothstep(-.8,.8,q.x));
  ink=mix(ink,childInk,clamp(identity,0.,1.)*separation());
  ink=mix(ink,warmInk,clamp(identity-1.,0.,1.)*separation());
  ink=mix(ink,vec3(.69,.66,.34),clamp(identity-2.,0.,1.)*releaseC());
  float core=1.-smoothstep(.08,.24,abs(fold));
  float halo=exp(-pow(fold*5.5,2.));
  color=mix(color,ink,core*.80*depth);
  color+=vec3(.19,.15,.34)*halo*.14*depth;
  float shining=exp(-pow((fold-.19)*12.,2.));
  color+=mix(vec3(.45,.62,1.),vec3(1.,.48,.81),smoothstep(-.7,.6,q.x))*shining*.27*depth;
  // Each released form dissolves in turn, followed by the original thought.
  float delay=identity<.5?.72:(identity<1.5?0.:(identity<2.5?.24:.48));
  float fade=smoothstep(delay,delay+1.05,departureTime);
  color=mix(color,sky(screenUV),fade*.65);
  // Keep transparent pixels premultiplied so CSS blur cannot expose bright RGB.
  float alpha=1.-fade;
  gl_FragColor=vec4(clamp(color,0.,1.)*alpha,alpha);
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
    const exitClock = gl.getUniformLocation(program, "departureTime");
    const clock = gl.getUniformLocation(program, "time"),
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
    // Three visual forms illustrate shaping; they do not count source records.
    gl.uniform1f(gl.getUniformLocation(program, "formCount"), extended ? 4 : 3);
    let ready = false,
      departedAt = null;
    const stage = canvas.closest(".orb-stage");
    draw = (now) => {
      if (dead) return;
      if (departedAt === null && stage.classList.contains("orb-departing"))
        departedAt = now;
      gl.uniform1f(
        exitClock,
        departedAt === null ? -1 : (now - departedAt) / 1000,
      );
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
