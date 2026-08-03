import fs from "fs";
import path from "path";

const outputDir = path.join(process.cwd(), "public", "chips");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Helper to generate futuristic cyberpunk SVG models for 13 distinct chips
function generateChipSVG(index) {
  const size = 512;
  const cx = 256;
  const cy = 256;

  // Each chip model has unique geometry and detailing
  let innerElements;

  switch (index) {
    case 1: // Stargate Portal Ring
      innerElements = `
        <!-- Outer Ring Teeth -->
        <g stroke="#1a202c" stroke-width="12" fill="none">
          <circle cx="${cx}" cy="${cy}" r="210" stroke="#0d1117" stroke-width="24" />
          <circle cx="${cx}" cy="${cy}" r="190" stroke="#161b22" stroke-width="8" stroke-dasharray="18 12" />
        </g>
        <!-- Metallic Armor Segments -->
        <circle cx="${cx}" cy="${cy}" r="170" fill="url(#metalGrad)" stroke="#30363d" stroke-width="6" />
        <!-- Neon Energy Ring -->
        <circle cx="${cx}" cy="${cy}" r="140" fill="none" stroke="url(#neonGlow)" stroke-width="14" filter="url(#glow)" />
        <!-- Radial Vanes -->
        <g stroke="#000" stroke-width="4" opacity="0.8">
          ${Array.from({ length: 12 }, (_, i) => {
            const angle = (i * 30 * Math.PI) / 180;
            const x1 = cx + 100 * Math.cos(angle);
            const y1 = cy + 100 * Math.sin(angle);
            const x2 = cx + 165 * Math.cos(angle);
            const y2 = cy + 165 * Math.sin(angle);
            return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="6"/>
                    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#neonGlow)" stroke-width="2"/>`;
          }).join("")}
        </g>
        <!-- Center Core Reactor -->
        <circle cx="${cx}" cy="${cy}" r="80" fill="#090d16" stroke="url(#neonGlow)" stroke-width="8" />
        <circle cx="${cx}" cy="${cy}" r="50" fill="url(#neonGlow)" filter="url(#glow)" />
        <circle cx="${cx}" cy="${cy}" r="25" fill="#ffffff" />
      `;
      break;

    case 2: // Heavy Cyber Cube / Pod
      innerElements = `
        <!-- Floating Base Shadow/Pedestal -->
        <ellipse cx="${cx}" cy="420" rx="160" ry="30" fill="#0d1117" stroke="url(#neonGlow)" stroke-width="4" />
        <ellipse cx="${cx}" cy="420" rx="120" ry="20" fill="none" stroke="url(#neonGlow)" stroke-width="8" filter="url(#glow)" />
        
        <!-- Cube Armor Body -->
        <g filter="url(#dropShadow)">
          <path d="M 150 140 L 256 80 L 362 140 L 362 290 L 256 350 L 150 290 Z" fill="url(#metalGrad)" stroke="#30363d" stroke-width="8" />
          <path d="M 256 80 L 256 350" stroke="#0d1117" stroke-width="6" />
          <path d="M 150 140 L 256 200 L 362 140" stroke="#0d1117" stroke-width="6" />
        </g>
        <!-- Glowing Core Circuits on Faces -->
        <path d="M 180 180 L 230 210 L 230 280 L 180 250 Z" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <path d="M 332 180 L 282 210 L 282 280 L 332 250 Z" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <circle cx="${cx}" cy="200" r="24" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 3: // Orbital Sphere Droid
      innerElements = `
        <ellipse cx="${cx}" cy="430" rx="150" ry="25" fill="#000" opacity="0.6" />
        <ellipse cx="${cx}" cy="430" rx="130" ry="18" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <!-- Spherical Body -->
        <circle cx="${cx}" cy="230" r="170" fill="url(#sphereGrad)" stroke="#21262d" stroke-width="8" />
        <!-- Latitude Seams -->
        <path d="M 80 210 Q 256 270 432 210" fill="none" stroke="url(#neonGlow)" stroke-width="10" filter="url(#glow)" />
        <path d="M 100 160 Q 256 210 412 160" fill="none" stroke="#161b22" stroke-width="6" />
        <path d="M 100 280 Q 256 330 412 280" fill="none" stroke="#161b22" stroke-width="6" />
        <!-- Longitude Seams -->
        <path d="M 256 60 Q 320 230 256 400" fill="none" stroke="url(#neonGlow)" stroke-width="4" filter="url(#glow)" />
        <!-- Center Optic Visor -->
        <circle cx="${cx}" cy="230" r="45" fill="#090d16" stroke="url(#neonGlow)" stroke-width="6" />
        <circle cx="${cx}" cy="230" r="25" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 4: // Tech Core Sphere
      innerElements = `
        <ellipse cx="${cx}" cy="430" rx="140" ry="20" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="175" fill="url(#metalGrad)" stroke="#30363d" stroke-width="8" />
        <!-- Panel grid -->
        <circle cx="${cx}" cy="220" r="140" fill="none" stroke="#0d1117" stroke-width="12" stroke-dasharray="40 20" />
        <circle cx="${cx}" cy="220" r="110" fill="none" stroke="url(#neonGlow)" stroke-width="8" filter="url(#glow)" />
        <!-- Diodes around sphere -->
        ${Array.from({ length: 8 }, (_, i) => {
          const angle = (i * 45 * Math.PI) / 180;
          const x = cx + 140 * Math.cos(angle);
          const y = 220 + 140 * Math.sin(angle);
          return `<circle cx="${x}" cy="${y}" r="12" fill="url(#neonGlow)" filter="url(#glow)"/>`;
        }).join("")}
        <circle cx="${cx}" cy="220" r="55" fill="#000" stroke="url(#neonGlow)" stroke-width="6" />
        <polygon points="${cx},180 ${cx + 35},240 ${cx - 35},240" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 5: // Gyroscope Neon Wheel
      innerElements = `
        <ellipse cx="${cx}" cy="420" rx="150" ry="25" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <!-- Outer Wheel Rim -->
        <circle cx="${cx}" cy="220" r="180" fill="none" stroke="url(#metalGrad)" stroke-width="36" />
        <circle cx="${cx}" cy="220" r="180" fill="none" stroke="#000" stroke-width="4" />
        <circle cx="${cx}" cy="220" r="195" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="162" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <!-- Inner Gyro Axles -->
        <ellipse cx="${cx}" cy="220" rx="120" ry="40" fill="none" stroke="url(#neonGlow)" stroke-width="8" transform="rotate(30 ${cx} 220)" filter="url(#glow)" />
        <ellipse cx="${cx}" cy="220" rx="120" ry="40" fill="none" stroke="url(#neonGlow)" stroke-width="8" transform="rotate(-30 ${cx} 220)" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="40" fill="#000" stroke="url(#neonGlow)" stroke-width="6" />
        <circle cx="${cx}" cy="220" r="20" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 6: // Cyber Tesseract / Hypercube
      innerElements = `
        <ellipse cx="${cx}" cy="430" rx="140" ry="25" fill="none" stroke="url(#neonGlow)" stroke-width="8" filter="url(#glow)" />
        <!-- Outer Box -->
        <g stroke="url(#neonGlow)" stroke-width="6" fill="none" filter="url(#glow)">
          <polygon points="256,70 380,140 380,290 256,360 132,290 132,140" stroke="url(#metalGrad)" fill="url(#metalGrad)" stroke-width="8" />
          <line x1="256" y1="70" x2="256" y2="360" stroke="#0d1117" stroke-width="6" />
          <line x1="132" y1="140" x2="256" y2="215" stroke="#0d1117" stroke-width="6" />
          <line x1="380" y1="140" x2="256" y2="215" stroke="#0d1117" stroke-width="6" />
          <!-- Inner Floating Glowing Tesseract -->
          <polygon points="256,150 310,180 310,240 256,270 202,240 202,180" fill="none" stroke="url(#neonGlow)" stroke-width="6" />
          <line x1="256" y1="150" x2="256" y2="270" />
          <line x1="202" y1="180" x2="256" y2="210" />
          <line x1="310" y1="180" x2="256" y2="210" />
        </g>
        <circle cx="${cx}" cy="210" r="25" fill="#ffffff" filter="url(#glow)" />
      `;
      break;

    case 7: // Holographic Shield Disc
      innerElements = `
        <!-- Shield Disc Base -->
        <circle cx="${cx}" cy="${cy}" r="200" fill="url(#metalGrad)" stroke="#30363d" stroke-width="10" />
        <circle cx="${cx}" cy="${cy}" r="175" fill="none" stroke="#0d1117" stroke-width="16" stroke-dasharray="30 15" />
        <circle cx="${cx}" cy="${cy}" r="150" fill="none" stroke="url(#neonGlow)" stroke-width="12" filter="url(#glow)" />
        <!-- Cross Shield Emblem -->
        <path d="M 256 110 L 330 160 L 330 280 L 256 340 L 182 280 L 182 160 Z" fill="#090d16" stroke="url(#neonGlow)" stroke-width="6" />
        <path d="M 256 130 L 310 170 L 310 265 L 256 310 L 202 265 L 202 170 Z" fill="url(#neonGlow)" opacity="0.25" />
        <circle cx="${cx}" cy="${cy}" r="35" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 8: // Heavy Drone Capsule
      innerElements = `
        <ellipse cx="${cx}" cy="420" rx="130" ry="20" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <!-- Capsule Shell -->
        <path d="M 130 200 C 130 90, 382 90, 382 200 L 360 320 L 256 370 L 152 320 Z" fill="url(#sphereGrad)" stroke="#30363d" stroke-width="8" />
        <!-- Visor Band -->
        <path d="M 140 180 Q 256 220 372 180 L 368 220 Q 256 260 144 220 Z" fill="url(#neonGlow)" filter="url(#glow)" />
        <!-- Lower Thruster Pipes -->
        <rect x="200" y="340" width="20" height="40" fill="#161b22" stroke="url(#neonGlow)" stroke-width="2" />
        <rect x="292" y="340" width="20" height="40" fill="#161b22" stroke="url(#neonGlow)" stroke-width="2" />
        <circle cx="${cx}" cy="280" r="30" fill="#000" stroke="url(#neonGlow)" stroke-width="4" />
        <circle cx="${cx}" cy="280" r="15" fill="#fff" filter="url(#glow)" />
      `;
      break;

    case 9: // Quantum Multi-Lens Sphere
      innerElements = `
        <ellipse cx="${cx}" cy="430" rx="140" ry="22" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="170" fill="url(#sphereGrad)" stroke="#21262d" stroke-width="8" />
        <!-- Multi Lenses -->
        <circle cx="${cx}" cy="180" r="45" fill="#000" stroke="url(#neonGlow)" stroke-width="6" />
        <circle cx="${cx}" cy="180" r="25" fill="url(#neonGlow)" filter="url(#glow)" />
        
        <circle cx="180" cy="270" r="32" fill="#000" stroke="url(#neonGlow)" stroke-width="5" />
        <circle cx="180" cy="270" r="18" fill="url(#neonGlow)" filter="url(#glow)" />

        <circle cx="332" cy="270" r="32" fill="#000" stroke="url(#neonGlow)" stroke-width="5" />
        <circle cx="332" cy="270" r="18" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 10: // Levitating Cyber Coin
      innerElements = `
        <ellipse cx="${cx}" cy="410" rx="170" ry="30" fill="none" stroke="url(#neonGlow)" stroke-width="8" filter="url(#glow)" />
        <!-- Coin Body -->
        <ellipse cx="${cx}" cy="220" rx="180" ry="140" fill="url(#metalGrad)" stroke="#30363d" stroke-width="10" />
        <ellipse cx="${cx}" cy="220" rx="150" ry="110" fill="none" stroke="#0d1117" stroke-width="12" />
        <ellipse cx="${cx}" cy="220" rx="130" ry="90" fill="none" stroke="url(#neonGlow)" stroke-width="8" filter="url(#glow)" />
        <!-- Cyber Sigil -->
        <path d="M 210 220 H 302 M 256 170 V 270" stroke="url(#neonGlow)" stroke-width="10" filter="url(#glow)" stroke-linecap="round" />
        <circle cx="${cx}" cy="220" r="30" fill="#000" stroke="url(#neonGlow)" stroke-width="4" />
        <circle cx="${cx}" cy="220" r="15" fill="#fff" />
      `;
      break;

    case 11: // Bio-Tech Alien Capsule
      innerElements = `
        <ellipse cx="${cx}" cy="430" rx="120" ry="20" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <!-- Egg Shell -->
        <path d="M 256 50 C 370 50, 390 250, 340 370 C 300 410, 212 410, 172 370 C 122 250, 142 50, 256 50 Z" fill="url(#sphereGrad)" stroke="#30363d" stroke-width="8" />
        <!-- Bio Chambers -->
        <path d="M 220 120 Q 256 100 292 120 L 310 280 Q 256 310 202 280 Z" fill="url(#neonGlow)" filter="url(#glow)" opacity="0.8" />
        <path d="M 220 120 Q 256 100 292 120 L 310 280 Q 256 310 202 280 Z" fill="none" stroke="#000" stroke-width="6" />
        <circle cx="${cx}" cy="200" r="25" fill="#fff" filter="url(#glow)" />
      `;
      break;

    case 12: // Heavy Armor Rotor Wheel
      innerElements = `
        <ellipse cx="${cx}" cy="420" rx="160" ry="25" fill="none" stroke="url(#neonGlow)" stroke-width="6" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="185" fill="url(#metalGrad)" stroke="#30363d" stroke-width="10" />
        <!-- Treads -->
        ${Array.from({ length: 16 }, (_, i) => {
          const angle = (i * 22.5 * Math.PI) / 180;
          const x1 = cx + 160 * Math.cos(angle);
          const y1 = 220 + 160 * Math.sin(angle);
          const x2 = cx + 185 * Math.cos(angle);
          const y2 = 220 + 185 * Math.sin(angle);
          return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0d1117" stroke-width="8"/>`;
        }).join("")}
        <circle cx="${cx}" cy="220" r="130" fill="none" stroke="url(#neonGlow)" stroke-width="12" filter="url(#glow)" />
        <circle cx="${cx}" cy="220" r="70" fill="#0d1117" stroke="url(#neonGlow)" stroke-width="6" />
        <polygon points="${cx - 25},195 ${cx + 30},220 ${cx - 25},245" fill="url(#neonGlow)" filter="url(#glow)" />
      `;
      break;

    case 13: // Twin-Eye Cyber Disc
    default:
      innerElements = `
        <circle cx="${cx}" cy="${cy}" r="195" fill="url(#metalGrad)" stroke="#30363d" stroke-width="8" />
        <circle cx="${cx}" cy="${cy}" r="165" fill="none" stroke="url(#neonGlow)" stroke-width="10" filter="url(#glow)" />
        <path d="M 120 256 H 392" stroke="#0d1117" stroke-width="12" />
        <!-- Dual Optics -->
        <circle cx="200" cy="256" r="35" fill="#000" stroke="url(#neonGlow)" stroke-width="6" />
        <circle cx="200" cy="256" r="18" fill="url(#neonGlow)" filter="url(#glow)" />

        <circle cx="312" cy="256" r="35" fill="#000" stroke="url(#neonGlow)" stroke-width="6" />
        <circle cx="312" cy="256" r="18" fill="url(#neonGlow)" filter="url(#glow)" />
        
        <circle cx="${cx}" cy="${cy}" r="15" fill="#fff" />
      `;
      break;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <defs>
      <!-- Base Metallic Gradients -->
      <radialGradient id="metalGrad" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#38444d" />
        <stop offset="50%" stop-color="#1f2933" />
        <stop offset="100%" stop-color="#0b0f14" />
      </radialGradient>

      <radialGradient id="sphereGrad" cx="30%" cy="25%" r="75%">
        <stop offset="0%" stop-color="#485665" />
        <stop offset="40%" stop-color="#212932" />
        <stop offset="85%" stop-color="#0c1015" />
        <stop offset="100%" stop-color="#05070a" />
      </radialGradient>

      <!-- Placeholder Neon Glow gradient (will be dynamically colored via CSS/JS or default cyber cyan/green) -->
      <!-- Свечение фишки. Цвет подставляется на стороне приложения из
           профиля игрока (см. src/components/ChipImage.tsx): фишка должна
           светиться тем цветом, который человек выбрал при входе, а не
           одинаковым зелёно-голубым у всех.
           Значения в var(...) — запасные, на случай показа вне игры. -->
      <linearGradient id="neonGlow" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="var(--chip-glow, #00ffaa)" />
        <stop offset="100%" stop-color="var(--chip-glow-2, #00ccff)" />
      </linearGradient>

      <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      <filter id="dropShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#000" flood-opacity="0.8" />
      </filter>
    </defs>

    ${innerElements}
  </svg>`;
}

async function run() {
  console.log("Generating 13 chip model files in /public/chips/...");

  // Только SVG. Раньше рядом клался ещё и PNG, и именно он оказался
  // повреждён: сигнатура файла (байт 0x89) была испорчена при обработке
  // как текст, и браузер не мог отрисовать ни одну фишку. Вектор к тому же
  // весит в 12 раз меньше, не зависит от плотности экрана и позволяет
  // покрасить свечение в цвет игрока.
  for (let i = 1; i <= 13; i++) {
    const svgContent = generateChipSVG(i);
    const svgPath = path.join(outputDir, `chip_${i}.svg`);

    fs.writeFileSync(svgPath, svgContent, "utf-8");
    console.log(`Generated chip_${i}.svg`);
  }

  console.log("All 13 chip models generated successfully!");
}

run().catch((e) => {
  console.error("Error generating chips:", e);
  process.exit(1);
});
