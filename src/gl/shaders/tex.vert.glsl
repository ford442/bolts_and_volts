#version 300 es
// One instanced unit quad per sprite. Per-vertex: the quad corner and its 0..1 texCoord. Per-instance (divisor 1,
// packed by src/gl/spriteBatch.ts, INSTANCE_FLOATS = 16): everything that used to be a per-draw uniform.
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texCoord;
layout(location = 2) in vec4 a_model;       // xy: centre (world units, anchor/parallax already applied), zw: size
layout(location = 3) in vec4 a_frame;       // xy: frame top-left in the sheet (px), zw: frame size (px)
layout(location = 4) in vec4 a_sheet;       // xy: sheet size (px), z: flip horizontally (0/1), w: alpha
layout(location = 5) in vec4 a_tint;        // rgb: multiplier, a: how much of the sample's own hue to drop first
uniform mat4 u_projection;
uniform vec2 u_camera_position;
out vec2 v_frameUv;
flat out float v_alpha;
flat out vec4 v_tint;
void main() {
  vec2 world_position = (a_position * a_model.zw) + a_model.xy;
  vec2 view_position = world_position - u_camera_position;
  gl_Position = u_projection * vec4(view_position, 0.0, 1.0);
  vec2 texCoord = a_texCoord;
  if (a_sheet.z > 0.5) texCoord.x = 1.0 - texCoord.x;
  // Linear in texCoord, so computing it per vertex interpolates to the same per-pixel value as doing it in the fragment.
  v_frameUv = (a_frame.xy + texCoord * a_frame.zw) / a_sheet.xy;
  v_alpha = a_sheet.w;
  v_tint = a_tint;
}
