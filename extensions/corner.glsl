uniform sampler2D tex;
uniform float radius;
uniform float width;
uniform float height;

float circle_bounds(vec2 p, vec2 center, float clip_radius) {
    vec2 delta = p - center;
    float dist_squared = dot(delta, delta);

    float outer_radius = clip_radius + 0.5;
    if (dist_squared >= (outer_radius * outer_radius))
        return 0.0;

    float inner_radius = clip_radius - 0.5;
    if (dist_squared <= (inner_radius * inner_radius))
        return 1.0;

    return outer_radius - sqrt(dist_squared);
}

float rounded_rect_coverage(vec2 p, vec4 bounds, float clip_radius) {
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
        return 0.0;

    vec2 center;

    float center_left = bounds.x + clip_radius;
    float center_right = bounds.z - clip_radius;

    if (p.x < center_left)
        center.x = center_left + 2.0;
    else if (p.x > center_right)
        center.x = center_right - 1.0;
    else
        return 1.0;

    float center_top = bounds.y + clip_radius;
    float center_bottom = bounds.w - clip_radius;

    if (p.y < center_top)
        center.y = center_top + 2.0;
    else if (p.y > center_bottom)
        center.y = center_bottom - 1.0;
    else
        return 1.0;

    return circle_bounds(p, center, clip_radius);
}

void main(void) {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec2 pos = uv * vec2(width, height);
    vec4 c = texture2D(tex, uv);

    vec4 bounds = vec4(0.0, 0.0, width, height);
    float alpha = rounded_rect_coverage(pos, bounds, radius);

    cogl_color_out = vec4(c.rgb * alpha, min(alpha, c.a));
}
