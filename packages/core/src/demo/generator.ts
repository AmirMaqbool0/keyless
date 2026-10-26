/**
 * Deterministic fake data for a UK catering/janitorial wholesaler: catalogue, customers,
 * price lists, contract prices and customer cross-references. Used by the MockConnector,
 * the seed script and the sample CSV files. Same seed -> same data.
 *
 * All customer domains use the reserved `.example` TLD so nothing here can reach a real inbox.
 */

export type DemoProduct = {
  sku: string;
  description: string;
  uom: string;
  packSize: number;
  barcode: string;
  defaultPrice: number;
  stockQty: number;
  active: boolean;
};

export type DemoCustomer = {
  accountCode: string;
  name: string;
  emailDomains: string[];
  senderAddresses: string[];
  priceListCode?: string;
  creditHold: boolean;
  deliveryAddresses: {
    label: string;
    line1: string;
    line2?: string;
    city: string;
    postcode: string;
    country: string;
  }[];
};

export type DemoPrice = {
  accountCode?: string;
  priceListCode?: string;
  sku: string;
  price: number;
  currency: string;
  minQty?: number;
};

export type DemoCrossReference = {
  accountCode: string;
  customerPartCode?: string;
  customerDescription?: string;
  sku: string;
  customerUom?: string;
  uomFactor?: number;
};

export type DemoData = {
  products: DemoProduct[];
  customers: DemoCustomer[];
  prices: DemoPrice[];
  crossReferences: DemoCrossReference[];
};

/** mulberry32: tiny, fast, seedable PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
    shuffle: <T>(arr: T[]): T[] => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    },
  };
}

type Category = {
  prefix: string;
  uom: string;
  basePrice: number;
  /** Each inner array is one attribute dimension; descriptions join one value from each. */
  dims: string[][];
  packs: number[];
  packLabel: string;
};

const BRANDS = ['Hygenix', 'ProClean', 'Caterpak', 'Brite'];

const CATEGORIES: Category[] = [
  {
    prefix: 'GL',
    uom: 'BOX',
    basePrice: 4.2,
    packLabel: 'Box',
    packs: [100, 200],
    dims: [
      BRANDS.slice(0, 3),
      ['Nitrile', 'Vinyl', 'Latex', 'Polythene'],
      ['Gloves'],
      ['Powder Free', 'Lightly Powdered'],
      ['Blue', 'Black', 'White', 'Clear'],
      ['XS', 'Small', 'Medium', 'Large', 'XL'],
    ],
  },
  {
    prefix: 'BL',
    uom: 'CASE',
    basePrice: 9.5,
    packLabel: 'Case',
    packs: [200, 500],
    dims: [
      BRANDS.slice(1, 3),
      [
        'Swing Bin Liner',
        'Pedal Bin Liner',
        'Refuse Sack',
        'Compactor Sack',
        'Clinical Waste Sack',
      ],
      ['Black', 'Clear', 'White', 'Yellow', 'Blue', 'Green', 'Red'],
      ['11x17x18"', '15x24x24"', '18x29x39"', '22x34x47"'],
      ['Light Duty', 'Medium Duty', 'Heavy Duty'],
    ],
  },
  {
    prefix: 'FC',
    uom: 'CASE',
    basePrice: 18,
    packLabel: 'Case',
    packs: [250, 500],
    dims: [
      [
        'Microwave Container',
        'Deli Container',
        'Kraft Food Box',
        'Bagasse Clamshell',
        'Aluminium Foil Container',
        'Soup Container',
      ],
      ['8oz', '12oz', '16oz', '26oz', '32oz'],
      ['with Lid', 'Base Only'],
    ],
  },
  {
    prefix: 'CU',
    uom: 'CASE',
    basePrice: 22,
    packLabel: 'Case',
    packs: [500, 1000],
    dims: [
      [
        'Single Wall Paper Cup',
        'Double Wall Paper Cup',
        'Ripple Cup',
        'Plastic Pint Cup',
        'Water Cup',
      ],
      ['4oz', '8oz', '10oz', '12oz', '16oz'],
      ['White', 'Kraft', 'Black', 'Printed'],
    ],
  },
  {
    prefix: 'LD',
    uom: 'CASE',
    basePrice: 15,
    packLabel: 'Case',
    packs: [1000],
    dims: [
      ['Sip Lid', 'Domed Lid', 'Flat Lid'],
      ['8oz', '12oz', '16oz'],
      ['White', 'Black'],
    ],
  },
  {
    prefix: 'NP',
    uom: 'CASE',
    basePrice: 12,
    packLabel: 'Case',
    packs: [1000, 2000],
    dims: [
      ['1 Ply', '2 Ply', '3 Ply'],
      ['Napkin'],
      ['24cm', '33cm', '40cm'],
      ['White', 'Black', 'Red', 'Navy', 'Burgundy', 'Kraft'],
      ['4 Fold', '8 Fold'],
    ],
  },
  {
    prefix: 'CH',
    uom: 'CASE',
    basePrice: 11,
    packLabel: 'Case',
    packs: [2, 6],
    dims: [
      BRANDS,
      [
        'Washing Up Liquid',
        'Multi-Surface Cleaner',
        'Thick Bleach',
        'Washroom Cleaner',
        'Glass Cleaner',
        'Heavy Duty Degreaser',
        'Floor Cleaner',
        'Hand Soap',
        'Hand Sanitiser Gel',
        'Oven Cleaner',
        'Dishwasher Detergent',
        'Rinse Aid',
        'Toilet Cleaner',
        'Disinfectant',
        'Air Freshener',
      ],
      ['750ml', '1L', '5L', '20L'],
      ['Original', 'Lemon', 'Lavender', 'Unfragranced'],
    ],
  },
  {
    prefix: 'PP',
    uom: 'CASE',
    basePrice: 24,
    packLabel: 'Pack',
    packs: [6, 12, 24, 36],
    dims: [
      [
        'Centrefeed Roll',
        'C-Fold Hand Towel',
        'Z-Fold Hand Towel',
        'Toilet Roll',
        'Mini Jumbo Toilet Roll',
        'Kitchen Roll',
        'Couch Roll',
        'Wiper Roll',
      ],
      ['1 Ply', '2 Ply', '3 Ply'],
      ['White', 'Blue'],
    ],
  },
  {
    prefix: 'CT',
    uom: 'BOX',
    basePrice: 6,
    packLabel: 'Box',
    packs: [100, 1000],
    dims: [
      ['Wooden', 'CPLA', 'Reusable Plastic', 'Bamboo'],
      ['Knife', 'Fork', 'Spoon', 'Teaspoon', 'Stirrer'],
      ['Natural', 'Black', 'White'],
    ],
  },
  {
    prefix: 'FF',
    uom: 'EACH',
    basePrice: 8,
    packLabel: 'Pack',
    packs: [1, 6],
    dims: [
      ['Catering Foil', 'Cling Film', 'Baking Parchment'],
      ['300mm', '450mm'],
      ['75m', '100m', '300m'],
    ],
  },
  {
    prefix: 'MC',
    uom: 'PACK',
    basePrice: 5,
    packLabel: 'Pack',
    packs: [5, 10, 50],
    dims: [
      [
        'Kentucky Mop Head',
        'Socket Mop Head',
        'Microfibre Cloth',
        'Sponge Scourer',
        'Stainless Steel Scourer',
        'All Purpose Cloth',
      ],
      ['Red', 'Blue', 'Green', 'Yellow'],
    ],
  },
  {
    prefix: 'PE',
    uom: 'PACK',
    basePrice: 7,
    packLabel: 'Pack',
    packs: [100, 500, 1000],
    dims: [
      [
        'Disposable Apron',
        'Mob Cap Hairnet',
        'Beard Snood',
        'Overshoe',
        'Type IIR Face Mask',
        'Sleeve Protector',
      ],
      ['White', 'Blue', 'Red', 'Green', 'Yellow'],
    ],
  },
  {
    prefix: 'BG',
    uom: 'CASE',
    basePrice: 14,
    packLabel: 'Case',
    packs: [250, 500, 1000],
    dims: [
      [
        'Paper Carrier Bag Twisted Handle',
        'Paper Bag Flat Handle',
        'Sandwich Bag',
        'Food Bag',
        'Grip Seal Bag',
      ],
      ['Small', 'Medium', 'Large'],
      ['Kraft', 'White', 'Clear'],
    ],
  },
];

function cartesian(dims: string[][]): string[][] {
  return dims.reduce<string[][]>(
    (acc, dim) => acc.flatMap((prefix) => dim.map((v) => [...prefix, v])),
    [[]],
  );
}

function ean13(rand: ReturnType<typeof prng>): string {
  const digits = [5, 0, ...Array.from({ length: 10 }, () => rand.int(0, 9))];
  const sum = digits.reduce((s, d, i) => s + d * (i % 2 ? 3 : 1), 0);
  return digits.join('') + ((10 - (sum % 10)) % 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function generateProducts(count: number, rand: ReturnType<typeof prng>): DemoProduct[] {
  // Shuffle each category's combinations, then deal round-robin so any `count` is a mixed catalogue.
  const pools = CATEGORIES.map((cat) =>
    rand.shuffle(
      cartesian(cat.dims).flatMap((parts) => cat.packs.map((pack) => ({ cat, parts, pack }))),
    ),
  );
  const products: DemoProduct[] = [];
  const seq = new Map<string, number>();
  let i = 0;
  while (products.length < count && pools.some((p) => p.length)) {
    const pool = pools[i++ % pools.length]!;
    const item = pool.pop();
    if (!item) continue;
    const { cat, parts, pack } = item;
    const n = (seq.get(cat.prefix) ?? 1000) + 1;
    seq.set(cat.prefix, n);
    const sizeFactor = 1 + parts.join('').length / 60;
    products.push({
      sku: `${cat.prefix}${n}`,
      description: `${parts.join(' ')} (${cat.packLabel} ${pack})`,
      uom: cat.uom,
      packSize: pack,
      barcode: ean13(rand),
      defaultPrice: round2(
        cat.basePrice * sizeFactor * Math.sqrt(pack / cat.packs[0]!) * (0.85 + rand.next() * 0.3),
      ),
      stockQty: rand.chance(0.05) ? 0 : rand.int(1, 600),
      active: !rand.chance(0.03),
    });
  }
  return products;
}

const NAME_WORDS = [
  'Brew',
  'Bean',
  'Harbour',
  'Oak',
  'Willow',
  'Station',
  'Market',
  'Riverside',
  'Castle',
  'Kings',
  'Meadow',
  'Northgate',
  'Copper',
  'Lantern',
  'Granary',
  'Elm',
  'Bridge',
  'Rose',
  'Thistle',
  'Abbey',
  'Quayside',
  'Orchard',
  'Foundry',
  'Mill',
];
const BUSINESS_TYPES = [
  'Cafe',
  'Kitchen',
  'Bistro',
  'Care Home',
  'Primary School',
  'Hotel',
  'Deli',
  'Bakery',
  'Cleaning Services',
  'Catering Ltd',
  'Leisure Centre',
  'Pub & Dining',
];
const TOWNS: [string, string][] = [
  ['Leeds', 'LS'],
  ['Bristol', 'BS'],
  ['Manchester', 'M'],
  ['York', 'YO'],
  ['Bath', 'BA'],
  ['Norwich', 'NR'],
  ['Exeter', 'EX'],
  ['Chester', 'CH'],
  ['Sheffield', 'S'],
  ['Nottingham', 'NG'],
  ['Cardiff', 'CF'],
  ['Brighton', 'BN'],
];
const STREETS = [
  'High Street',
  'Station Road',
  'Church Lane',
  'Mill Road',
  'Victoria Street',
  'Park Avenue',
  'Queen Street',
  'Market Place',
  'Bridge Street',
  'Kings Road',
];

function postcode(prefix: string, rand: ReturnType<typeof prng>): string {
  const L = 'ABDEFGHJLNPQRSTUWXYZ';
  return `${prefix}${rand.int(1, 20)} ${rand.int(1, 9)}${rand.pick([...L])}${rand.pick([...L])}`;
}

function generateCustomers(count: number, rand: ReturnType<typeof prng>): DemoCustomer[] {
  const names = rand.shuffle(cartesian([NAME_WORDS, BUSINESS_TYPES])).slice(0, count);
  const perPrefix = new Map<string, number>();
  return names.map(([word, type], idx) => {
    const name = `${word} ${type}`;
    const prefix = word!.toUpperCase().slice(0, 4);
    const n = (perPrefix.get(prefix) ?? 0) + 1;
    perPrefix.set(prefix, n);
    const domain = `${name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '')}.example`;
    const [town, pc] = rand.pick(TOWNS);
    const addresses = [
      {
        label: 'Main',
        line1: `${rand.int(1, 220)} ${rand.pick(STREETS)}`,
        city: town,
        postcode: postcode(pc, rand),
        country: 'GB',
      },
    ];
    if (rand.chance(0.25)) {
      const [town2, pc2] = rand.pick(TOWNS);
      addresses.push({
        label: 'Second site',
        line1: `Unit ${rand.int(1, 40)}, ${rand.pick(STREETS)}`,
        city: town2,
        postcode: postcode(pc2, rand),
        country: 'GB',
      });
    }
    return {
      accountCode: `${prefix}${String(n).padStart(3, '0')}`,
      name,
      emailDomains: [domain],
      senderAddresses: [`orders@${domain}`, ...(rand.chance(0.4) ? [`purchasing@${domain}`] : [])],
      priceListCode: rand.chance(0.7) ? rand.pick(['A', 'B', 'C']) : undefined,
      creditHold: idx % 29 === 7,
      deliveryAddresses: addresses,
    };
  });
}

const LIST_DISCOUNT: Record<string, number> = { A: 0.95, B: 0.9, C: 0.85 };

function generatePrices(
  products: DemoProduct[],
  customers: DemoCustomer[],
  rand: ReturnType<typeof prng>,
): DemoPrice[] {
  const prices: DemoPrice[] = [];
  for (const [code, factor] of Object.entries(LIST_DISCOUNT)) {
    for (const p of products) {
      if (rand.chance(0.3))
        prices.push({
          priceListCode: code,
          sku: p.sku,
          price: round2(p.defaultPrice * factor),
          currency: 'GBP',
        });
    }
  }
  // Contract prices for a few bigger accounts, some with a quantity break.
  for (const c of customers.slice(0, 10)) {
    for (const p of rand.shuffle([...products]).slice(0, 30)) {
      const price = round2(p.defaultPrice * (0.8 + rand.next() * 0.1));
      prices.push({ accountCode: c.accountCode, sku: p.sku, price, currency: 'GBP' });
      if (rand.chance(0.2))
        prices.push({
          accountCode: c.accountCode,
          sku: p.sku,
          price: round2(price * 0.95),
          currency: 'GBP',
          minQty: 10,
        });
    }
  }
  return prices;
}

/** Each customer has its own house style for part codes, like real buyers do. */
const CODE_STYLES: ((sku: string, i: number, prefix: string) => string)[] = [
  (_s, i, prefix) => `${prefix}-${1000 + i * 7}`,
  (_s, i) => String(400000 + i * 13),
  (sku) => sku.replace(/^([A-Z]+)(\d+)$/, '$1-$2'),
  (_s, i, prefix) => `${prefix}/${String(i).padStart(4, '0')}`,
];

function generateCrossReferences(
  products: DemoProduct[],
  customers: DemoCustomer[],
  rand: ReturnType<typeof prng>,
): DemoCrossReference[] {
  const active = products.filter((p) => p.active);
  const refs: DemoCrossReference[] = [];
  customers.slice(0, Math.min(25, customers.length)).forEach((c, ci) => {
    const style = CODE_STYLES[ci % CODE_STYLES.length]!;
    const items = rand.shuffle([...active]).slice(0, rand.int(15, 40));
    items.forEach((p, i) => {
      const byEach = p.uom !== 'EACH' && rand.chance(0.15);
      refs.push({
        accountCode: c.accountCode,
        customerPartCode: style(p.sku, i + 1, c.accountCode.slice(0, 3)),
        customerDescription: rand.chance(0.5)
          ? p.description.replace(/\s*\(.*\)$/, '').toUpperCase()
          : undefined,
        sku: p.sku,
        customerUom: byEach ? 'EACH' : p.uom,
        uomFactor: byEach ? 1 / p.packSize : 1,
      });
    });
  });
  return refs;
}

export function generateDemoData(
  opts: { productCount?: number; customerCount?: number; seed?: number } = {},
): DemoData {
  const rand = prng(opts.seed ?? 42);
  const products = generateProducts(opts.productCount ?? 5000, rand);
  const customers = generateCustomers(
    Math.min(opts.customerCount ?? 60, NAME_WORDS.length * BUSINESS_TYPES.length),
    rand,
  );
  return {
    products,
    customers,
    prices: generatePrices(products, customers, rand),
    crossReferences: generateCrossReferences(products, customers, rand),
  };
}

/** Upper bound on distinct demo products. */
export const MAX_DEMO_PRODUCTS = CATEGORIES.reduce(
  (sum, c) => sum + c.dims.reduce((n, d) => n * d.length, 1) * c.packs.length,
  0,
);
