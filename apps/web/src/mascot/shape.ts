/** One closed outline: the curl deforms, but its attachment points stay fixed. */
export function mascotOutline(angle = 0) {
  const radians = (angle * Math.PI) / 180;
  function point(x: number, y: number) {
    // Fade deformation out near the two roots to preserve their tangents.
    const weight = Math.min(1, Math.max(0, (149 - y) / 65));
    const a = radians * weight;
    const dx = x - 166,
      dy = y - 112;
    return `${(166 + dx * Math.cos(a) - dy * Math.sin(a)).toFixed(3)} ${(112 + dx * Math.sin(a) + dy * Math.cos(a)).toFixed(3)}`;
  }
  return `M131 149
    C115 165 94 197 97 225
    C99 255 126 273 167 272
    C207 276 234 260 247 230
    C263 196 253 154 226 126
    C217 116 ${point(216, 102)} ${point(207, 91)}
    C${point(178, 60)} ${point(137, 34)} ${point(94, 42)}
    C${point(57, 48)} ${point(29, 82)} ${point(36, 117)}
    C${point(39, 139)} ${point(61, 156)} ${point(87, 150)}
    C${point(102, 147)} ${point(119, 129)} ${point(112, 120)}
    C${point(108, 115)} ${point(102, 116)} ${point(98, 123)}
    C${point(88, 135)} ${point(70, 133)} ${point(62, 123)}
    C${point(48, 107)} ${point(59, 78)} ${point(83, 67)}
    C${point(108, 55)} ${point(143, 64)} ${point(158, 88)}
    C${point(171, 109)} 151 129 131 149 Z`;
}
