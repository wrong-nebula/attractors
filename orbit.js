// Render into the plate's photographic grid. Camera motion changes the projection,
// while the density kernel, color ramp, and exposure stay in plate coordinates.
const width = 1080;
const height = 938;
const camera = `
struct Camera {
  rotation: vec4f,
  exposure: f32,
  count: u32,
  padding: vec2u,
  stops: array<vec4f,4>
};
@group(0) @binding(0) var<uniform> camera: Camera;
`;

const projectShader =
  camera +
  `
@group(0) @binding(1) var<storage,read> points: array<vec4f>;
@group(0) @binding(2) var<storage,read_write> field: array<atomic<u32>>;

@compute @workgroup_size(128)
fn project(@builtin(global_invocation_id) tid:vec3u) {
  if (tid.x >= camera.count) { return; }
  let p = points[tid.x];
  let r = camera.rotation;
  let x = p.x*r.x + p.z*r.y;
  let z = p.z*r.x - p.x*r.y;
  let y = p.y*r.z + z*r.w;
  let pixel = vec2f(540.0 + 840.0*x, 469.0 - 840.0*y);
  if (any(pixel < vec2f(0.0)) || any(pixel >= vec2f(1079.0,937.0))) { return; }
  let cell = vec2u(pixel);
  let index = cell.y*1080u + cell.x;
  let frac = fract(pixel);
  // Integer deposits conserve the full weight, including coincident visits.
  let mass = u32(p.w)*256u;
  let right = min(mass,u32(round(frac.x*f32(mass))));
  let left = mass - right;
  let belowLeft = min(left,u32(round(frac.y*f32(left))));
  let belowRight = min(right,u32(round(frac.y*f32(right))));
  atomicAdd(&field[index], left - belowLeft);
  atomicAdd(&field[index+1u], right - belowRight);
  atomicAdd(&field[index+1080u], belowLeft);
  atomicAdd(&field[index+1081u], belowRight);
}`;

const developShader =
  camera +
  `
@group(0) @binding(1) var<storage,read> field: array<u32>;
@group(0) @binding(2) var plate: texture_storage_2d<rgba8unorm,write>;
const ground = vec3f(4.,8.,13.) / 255.;
fn colorize(v:f32) -> vec3f {
  let s = camera.stops;
  if (v < .18) { return mix(ground,s[0].rgb,v/.18); }
  if (v < .51) { return mix(s[0].rgb,s[1].rgb,(v-.18)/.33); }
  if (v < .79) { return mix(s[1].rgb,s[2].rgb,(v-.51)/.28); }
  return mix(s[2].rgb,s[3].rgb,(v-.79)/.21);
}
@compute @workgroup_size(8,8)
fn develop(@builtin(global_invocation_id) tid:vec3u) {
  if (tid.x>=1080u || tid.y>=938u) { return; }
  let mass = field[tid.y*1080u+tid.x];
  var rgb = ground;
  if (mass!=0u) {
    let value = log(1. + f32(mass)*(2.5/256.)) * camera.exposure;
    rgb = colorize(pow(min(value,1.),.76));
  }
  textureStore(plate,tid.xy,vec4f(rgb,1.));
}`;

const displayShader = `
@group(0) @binding(0) var plate: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
struct Vertex { @builtin(position) p:vec4f, @location(0) uv:vec2f };
@vertex fn vertex(@builtin(vertex_index) i:u32)->Vertex {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  let p=positions[i];
  return Vertex(vec4f(p,0.,1.),p*vec2f(.5,-.5)+.5);
}
@fragment fn display(in:Vertex)->@location(0) vec4f {
  // Integrate the footprint when the plate is displayed smaller than native size.
  let dx=.25*dpdx(in.uv); let dy=.25*dpdy(in.uv);
  return .25*(textureSample(plate,linearSampler,in.uv-dx-dy)
    + textureSample(plate,linearSampler,in.uv+dx-dy)
    + textureSample(plate,linearSampler,in.uv-dx+dy)
    + textureSample(plate,linearSampler,in.uv+dx+dy));
}`;

export async function makeOrbit(canvas, onLost) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then(onLost);
  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  function compute(code, entryPoint) {
    return device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code }), entryPoint },
    });
  }
  const displayModule = device.createShaderModule({ code: displayShader });
  const [project, develop, display] = await Promise.all([
    compute(projectShader, "project"),
    compute(developShader, "develop"),
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: displayModule, entryPoint: "vertex" },
      fragment: {
        module: displayModule,
        entryPoint: "display",
        targets: [{ format }],
      },
    }),
  ]);
  const params = new ArrayBuffer(96);
  const floats = new Float32Array(params);
  const uniform = device.createBuffer({
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const field = device.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const plate = device
    .createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    })
    .createView();
  const sampler = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
  });
  function bindings(pipeline, resources) {
    return device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }
  const developGroup = bindings(develop, [
    { buffer: uniform },
    { buffer: field },
    plate,
  ]);
  const displayGroup = bindings(display, [plate, sampler]);
  let buffer,
    projectGroup,
    count = 0;
  function load(raw) {
    const header = new DataView(raw);
    if (raw.byteLength < 28 || header.getUint32(0, false) !== 0x41474431)
      throw Error("Invalid orbit header");
    const size = header.getUint32(4, true);
    if (!size || raw.byteLength !== 28 + size * 10)
      throw Error("Invalid orbit data");
    const exposure = header.getFloat32(8, true);
    const unit = header.getFloat32(12, true);
    const stops = new Uint8Array(raw, 16, 12);
    const mass = new Uint32Array(raw, 28, size);
    const delta = new Int16Array(raw, 28 + size * 4);
    const vertices = new Float32Array(size * 4);
    for (let axis = 0; axis < 3; axis++) {
      let value = 0;
      for (let i = 0; i < size; i++) {
        // Packed deltas wrap in signed 16-bit arithmetic.
        value = ((value + delta[axis * size + i]) << 16) >> 16;
        vertices[4 * i + axis] = value * unit;
      }
    }
    for (let i = 0; i < size; i++) vertices[4 * i + 3] = mass[i];
    buffer?.destroy();
    buffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, vertices);
    projectGroup = bindings(project, [
      { buffer: uniform },
      { buffer },
      { buffer: field },
    ]);
    count = size;
    floats[4] = 1 / Math.log1p(2.5 * exposure);
    new Uint32Array(params)[5] = count;
    for (let stop = 0; stop < 4; stop++) {
      for (let c = 0; c < 3; c++)
        floats[8 + 4 * stop + c] = stops[3 * stop + c] / 255;
    }
    device.queue.writeBuffer(uniform, 0, params);
  }
  function draw(yaw, pitch) {
    if (!count) return;
    const scale = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * scale)),
      h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    floats.set([
      Math.cos(yaw),
      Math.sin(yaw),
      Math.cos(pitch),
      Math.sin(pitch),
    ]);
    device.queue.writeBuffer(uniform, 0, params, 0, 16);
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(field);
    const projection = encoder.beginComputePass();
    projection.setPipeline(project);
    projection.setBindGroup(0, projectGroup);
    projection.dispatchWorkgroups(Math.ceil(count / 128));
    projection.end();
    const tone = encoder.beginComputePass();
    tone.setPipeline(develop);
    tone.setBindGroup(0, developGroup);
    tone.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    tone.end();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 1],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(display);
    pass.setBindGroup(0, displayGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  return { load, draw };
}
