import type { Property } from "@/lib/properties";

const PALETTES: Record<Property["art"], { sky: string; body: string; side: string; glass: string }> = {
  tower: { sky: "#cfe3ef", body: "#1b3550", side: "#12263a", glass: "#8fc3d8" },
  mall: { sky: "#f3e3c9", body: "#7a4a2b", side: "#5e3820", glass: "#f2c27a" },
  office: { sky: "#d6e9df", body: "#245a4f", side: "#183f37", glass: "#9fd4c3" },
};

/** Generated illustration (no external images): a simple building on a sky band. */
export function BuildingArt({ property, height = 170 }: { property: Property; height?: number }) {
  const c = PALETTES[property.art];
  const tall = property.art === "tower";
  const wide = property.art === "mall";
  const w = wide ? 220 : tall ? 110 : 150;
  const h = tall ? 140 : wide ? 70 : 105;
  const x = 200 - w / 2;
  const y = 165 - h;
  const cols = Math.floor(w / 18);
  const rows = Math.floor(h / 16);
  const windows = [];
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      windows.push(
        <rect key={`${r}-${col}`} x={x + 8 + col * 18} y={y + 8 + r * 16} width={10} height={8} rx={1} fill={c.glass} opacity={(r + col) % 3 === 0 ? 0.55 : 0.95} />,
      );
    }
  }
  return (
    <svg className="art" viewBox="0 0 400 180" height={height} role="img" aria-label={property.name.en} preserveAspectRatio="xMidYMid slice">
      <rect width="400" height="180" fill={c.sky} />
      <rect x="0" y="165" width="400" height="15" fill="#9aa7b2" />
      <rect x={x + w} y={y + 10} width="18" height={h - 10} fill={c.side} />
      <rect x={x} y={y} width={w} height={h} fill={c.body} />
      {windows}
      <rect x={x - 30} y="145" width="18" height="20" rx="9" fill="#5f8f5a" />
      <rect x={x + w + 34} y="140" width="20" height="25" rx="10" fill="#5f8f5a" />
    </svg>
  );
}
