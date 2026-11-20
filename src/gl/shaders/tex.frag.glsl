#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform vec2 u_sprite_sheet_size;
uniform vec2 u_sprite_frame_size;
uniform vec2 u_sprite_frame_coord; // The top-left corner of the current frame in pixels
uniform float u_flip_horizontal; // A flag (0.0 or 1.0) to flip the sprite
uniform float u_alpha; // Global opacity multiplier (1.0 normally; lowered to dim sprites in authoring mode)
uniform vec4 u_tint; // rgb: multiplier applied after the sample; a: how much of the sample's own hue to drop first (0 keep, 1 grey). (1,1,1,0) = untinted; set only around the player draw
out vec4 outColor;
void main() {
  vec2 texCoord = v_texCoord;
  if (u_flip_horizontal > 0.5) {
    texCoord.x = 1.0 - texCoord.x;
  }
  vec2 frame_uv = (u_sprite_frame_coord + texCoord * u_sprite_frame_size) / u_sprite_sheet_size;
  outColor = texture(u_texture, frame_uv);
  // A plain multiply cannot turn the blue sheet warm (it makes it green), so a tint can first reduce the sample to its
  // brightness and colour that instead.
  float luma = dot(outColor.rgb, vec3(0.299, 0.587, 0.114));
  outColor.rgb = mix(outColor.rgb, vec3(luma), u_tint.a) * u_tint.rgb;
  outColor.a *= u_alpha;
}
