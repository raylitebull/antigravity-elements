// The 118 elements: symbol, name, category. Grid positions are derived from
// the atomic number in positionOf().
(function () {
  const SYMBOLS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
  const NAMES = 'Hydrogen Helium Lithium Beryllium Boron Carbon Nitrogen Oxygen Fluorine Neon Sodium Magnesium Aluminium Silicon Phosphorus Sulfur Chlorine Argon Potassium Calcium Scandium Titanium Vanadium Chromium Manganese Iron Cobalt Nickel Copper Zinc Gallium Germanium Arsenic Selenium Bromine Krypton Rubidium Strontium Yttrium Zirconium Niobium Molybdenum Technetium Ruthenium Rhodium Palladium Silver Cadmium Indium Tin Antimony Tellurium Iodine Xenon Caesium Barium Lanthanum Cerium Praseodymium Neodymium Promethium Samarium Europium Gadolinium Terbium Dysprosium Holmium Erbium Thulium Ytterbium Lutetium Hafnium Tantalum Tungsten Rhenium Osmium Iridium Platinum Gold Mercury Thallium Lead Bismuth Polonium Astatine Radon Francium Radium Actinium Thorium Protactinium Uranium Neptunium Plutonium Americium Curium Berkelium Californium Einsteinium Fermium Mendelevium Nobelium Lawrencium Rutherfordium Dubnium Seaborgium Bohrium Hassium Meitnerium Darmstadtium Roentgenium Copernicium Nihonium Flerovium Moscovium Livermorium Tennessine Oganesson'.split(' ');
  const ALIASES = { aluminum: 13, cesium: 55, sulphur: 16 };

  const NONMETAL = [1, 6, 7, 8, 15, 16, 34];
  const HALOGEN = [9, 17, 35, 53, 85, 117];
  const NOBLE = [2, 10, 18, 36, 54, 86, 118];
  const ALKALI = [3, 11, 19, 37, 55, 87];
  const ALKALINE = [4, 12, 20, 38, 56, 88];
  const METALLOID = [5, 14, 32, 33, 51, 52];
  const POST = [13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116];

  function category(z) {
    if (NONMETAL.includes(z)) return 'nonmetal';
    if (HALOGEN.includes(z)) return 'halogen';
    if (NOBLE.includes(z)) return 'noble';
    if (ALKALI.includes(z)) return 'alkali';
    if (ALKALINE.includes(z)) return 'alkaline';
    if (METALLOID.includes(z)) return 'metalloid';
    if (POST.includes(z)) return 'post';
    if (z >= 57 && z <= 71) return 'lanthanide';
    if (z >= 89 && z <= 103) return 'actinide';
    return 'transition';
  }

  // Grid row/col (1-based). Lanthanides go to row 9, actinides to row 10,
  // leaving row 8 as a spacer like a printed table.
  function positionOf(z) {
    if (z === 1) return [1, 1];
    if (z === 2) return [1, 18];
    const blocks = [
      [3, 10, 2], [11, 18, 3],
    ];
    for (const [a, b, row] of blocks) {
      if (z >= a && z <= b) {
        const i = z - a;
        return [row, i < 2 ? i + 1 : i + 11];
      }
    }
    if (z >= 19 && z <= 36) return [4, z - 18];
    if (z >= 37 && z <= 54) return [5, z - 36];
    if (z >= 57 && z <= 71) return [9, z - 57 + 3];
    if (z >= 89 && z <= 103) return [10, z - 89 + 3];
    if (z === 55 || z === 56) return [6, z - 54];
    if (z === 87 || z === 88) return [7, z - 86];
    if (z >= 72 && z <= 86) return [6, z - 72 + 4];
    if (z >= 104 && z <= 118) return [7, z - 104 + 4];
    return [1, 1];
  }

  const ELEMENTS = SYMBOLS.map((symbol, i) => {
    const z = i + 1;
    const [row, col] = positionOf(z);
    return { z, symbol, name: NAMES[i], category: category(z), row, col };
  });

  const BY_NAME = new Map(ELEMENTS.map((e) => [e.name.toLowerCase(), e]));
  for (const [alias, z] of Object.entries(ALIASES)) BY_NAME.set(alias, ELEMENTS[z - 1]);

  window.PERIODIC = { ELEMENTS, BY_NAME };
})();
