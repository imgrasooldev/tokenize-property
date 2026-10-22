import type { Property } from "@/lib/properties";

/** What the illustration needs: a stable id, a style and a name for the accessible label. */
export interface ArtSubject {
  key: string;
  art: Property["art"];
  name: { en: string };
}

/**
 * Generated neon illustration of the building (no external images; decorative, not a photo of the
 * property). Gradient ids are prefixed with `uid` so several illustrations can share a page.
 */
export function BuildingArt({ property, height = 220, uid = "a" }: { property: ArtSubject; height?: number; uid?: string }) {
  const id = `${property.key.replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}-${uid}`;
  return (
    <svg className="art-svg" viewBox="0 0 400 220" width="100%" height={height} role="img" aria-label={property.name.en} preserveAspectRatio="xMidYMid slice">
      {property.art === "tower" && (
        <>
          <defs>
            <linearGradient id={`b-${id}`} x1="0" x2="1">
              <stop stopColor="#1B2A5A" />
              <stop offset="1" stopColor="#0E1636" />
            </linearGradient>
            <linearGradient id={`g-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop stopColor="#22E3F0" />
              <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g stroke="#22E3F0" strokeOpacity=".15">
            <path d="M0 190 L400 190M60 220 L200 160 L340 220" />
          </g>
          <polygon points="200,30 290,75 290,190 200,210 110,190 110,75" fill={`url(#b-${id})`} stroke="#22E3F0" strokeOpacity=".5" />
          <polygon points="200,30 290,75 200,120 110,75" fill="#24366E" stroke="#22E3F0" strokeOpacity=".7" />
          <line x1="200" y1="120" x2="200" y2="210" stroke="#22E3F0" strokeOpacity=".6" />
          <g fill="#22E3F0">
            <rect x="125" y="100" width="10" height="5" opacity=".9" />
            <rect x="145" y="110" width="10" height="5" opacity=".4" />
            <rect x="165" y="120" width="10" height="5" opacity=".9" />
            <rect x="125" y="125" width="10" height="5" opacity=".6" />
            <rect x="145" y="135" width="10" height="5" opacity=".9" />
            <rect x="165" y="145" width="10" height="5" opacity=".5" />
            <rect x="125" y="150" width="10" height="5" opacity=".9" />
            <rect x="145" y="160" width="10" height="5" opacity=".7" />
          </g>
          <g fill="#8B5CF6">
            <rect x="215" y="120" width="10" height="5" opacity=".9" />
            <rect x="235" y="110" width="10" height="5" opacity=".5" />
            <rect x="255" y="100" width="10" height="5" opacity=".9" />
            <rect x="215" y="145" width="10" height="5" opacity=".6" />
            <rect x="235" y="135" width="10" height="5" opacity=".9" />
            <rect x="255" y="125" width="10" height="5" opacity=".4" />
            <rect x="215" y="170" width="10" height="5" opacity=".9" />
            <rect x="255" y="150" width="10" height="5" opacity=".8" />
          </g>
          <rect x="196" y="0" width="8" height="32" fill={`url(#g-${id})`} />
          <g fill="#22E3F0">
            <circle cx="60" cy="60" r="2" />
            <circle cx="340" cy="50" r="2" />
            <circle cx="360" cy="140" r="2" />
            <circle cx="40" cy="150" r="2" />
          </g>
          <g stroke="#22E3F0" strokeOpacity=".25">
            <path d="M60 60 L110 75M340 50 L290 75M360 140 L290 150M40 150 L110 150" />
          </g>
        </>
      )}
      {property.art === "mall" && (
        <>
          <defs>
            <linearGradient id={`b-${id}`} x1="0" x2="1">
              <stop stopColor="#20304F" />
              <stop offset="1" stopColor="#121B33" />
            </linearGradient>
          </defs>
          <polygon points="90,110 200,70 310,110 310,190 200,215 90,190" fill={`url(#b-${id})`} stroke="#2EF2B5" strokeOpacity=".5" />
          <polygon points="90,110 200,70 310,110 200,150" fill="#2A3D63" stroke="#2EF2B5" strokeOpacity=".6" />
          <line x1="200" y1="150" x2="200" y2="215" stroke="#2EF2B5" strokeOpacity=".5" />
          <g fill="#2EF2B5" fillOpacity=".8">
            <polygon points="105,140 140,128 140,160 105,172" />
            <polygon points="150,125 185,113 185,145 150,157" />
          </g>
          <g fill="#2EF2B5" fillOpacity=".35">
            <polygon points="215,147 250,159 250,191 215,179" />
            <polygon points="260,162 295,174 295,186 260,174" />
          </g>
          <g fill="#2EF2B5">
            <circle cx="50" cy="70" r="2" />
            <circle cx="350" cy="80" r="2" />
          </g>
        </>
      )}
      {property.art === "office" && (
        <>
          <defs>
            <linearGradient id={`b-${id}`} x1="0" x2="1">
              <stop stopColor="#2A1B55" />
              <stop offset="1" stopColor="#140C2E" />
            </linearGradient>
          </defs>
          <polygon points="200,18 260,48 260,195 200,215 140,195 140,48" fill={`url(#b-${id})`} stroke="#8B5CF6" strokeOpacity=".7" />
          <polygon points="200,18 260,48 200,78 140,48" fill="#3A2775" stroke="#F472B6" strokeOpacity=".6" />
          <line x1="200" y1="78" x2="200" y2="215" stroke="#8B5CF6" strokeOpacity=".6" />
          <g stroke="#F472B6" strokeOpacity=".8">
            <path d="M148 95 L196 115M148 120 L196 140M148 145 L196 165M148 170 L196 190" />
            <path d="M204 115 L252 95M204 140 L252 120M204 165 L252 145M204 190 L252 170" stroke="#8B5CF6" />
          </g>
          <polygon points="80,120 125,100 125,200 80,210" fill="#1A1240" stroke="#8B5CF6" strokeOpacity=".4" />
          <polygon points="275,100 320,120 320,210 275,200" fill="#1A1240" stroke="#8B5CF6" strokeOpacity=".4" />
          <g fill="#F472B6">
            <circle cx="40" cy="50" r="2" />
            <circle cx="360" cy="40" r="2" />
            <circle cx="370" cy="160" r="2" />
          </g>
        </>
      )}
    </svg>
  );
}
