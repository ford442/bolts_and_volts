#version 300 es
precision highp float;
in vec2 v_frameUv;
flat in float v_alpha; // per-sprite opacity (1.0 normally; lowered to dim sprites in authoring mode)
flat in vec4 v_tint;   // per-sprite: rgb multiplier after the sample; a: 0 keep the sample's hue, 1 grey first. (1,1,1,0) = untinted
uniform sampler2D u_texture;
out vec4 outColor;
void main() {
  outColor = texture(u_texture, v_frameUv);
  // A plain multiply cannot turn the blue sheet warm (it makes it green), so a tint can first reduce the sample to its
  // brightness and colour that instead.
  float luma = dot(outColor.rgb, vec3(0.299, 0.587, 0.114));
  outColor.rgb = mix(outColor.rgb, vec3(luma), v_tint.a) * v_tint.rgb;
  outColor.a *= v_alpha;
}
