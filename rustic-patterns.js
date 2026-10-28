// Patterns by Rustic Nastalje that come with ImadeIt. Text from "The Rustic Blanket" Breadcrumb pattern.
export const SHOP_URL = 'https://rusticnastalje.etsy.com';

export const RUSTIC_PATTERNS = [
  {
    id: 'rn-rustic',
    name: 'The Rustic Blanket',
    designer: 'Rustic Nastalje',
    tagline: 'A Breadcrumb pattern. Put it down anytime and pick up right where you left off.',
    summary: 'A one-colour chunky chenille blanket in simple knit rows, finished with a braided edge and an optional border. Four sizes, one pattern.',
    listing: 'https://www.etsy.com/listing/4591638912/the-rustic-finger-knit-blanket-pattern',
    supplies: ['Chunky chenille yarn, 1 colour', 'Scissors', 'Lighter'],
    yarnLink: 'https://linktr.ee/rusticnastalje',
    sizes: [
      { name: 'Petite', size: 'Baby', width: 25, length: 25, loops: 17, rows: 18 },
      { name: 'Lap Traveller', size: 'Lap', width: 35, length: 48, loops: 24, rows: 34 },
      { name: 'Nook Throw', size: 'Throw', width: 40, length: 60, loops: 27, rows: 42 },
      { name: 'Classic Throw', size: 'Throw', width: 50, length: 60, loops: 34, rows: 42 },
    ],
    // What to do on a given row (1-based) for a size with `rows` rows in total.
    row(n, rows) {
      if (n === 1) return 'Pull up a loop in every chain [all loops]';
      if (n === rows) return 'Knit [all loops]. Last row: make the loops slightly larger than usual, about the width of four fingers, so the edge doesn’t curve or pull tight.';
      return 'Knit [all loops]';
    },
    sections: [
      {
        title: 'Before you start',
        body: [
          'Make a slipknot, then chain the number of loops for your size (see Sizes).',
          'Every row has the same loop count as your cast on. Count before you tick a row, and a dropped loop never gets past you.',
        ],
      },
      {
        title: 'Joining a new skein',
        body: [
          'When a skein runs out, finish the row if you can, then join the next skein at the edge using the Burn Method before you start the next row. Joins at the edge stay hidden.',
          'Burn Method: hold the two cut yarn ends side by side and briefly melt them with a lighter, then press them together until they fuse. Let the join cool for a few seconds before you pull on it.',
        ],
      },
      {
        title: 'End your blanket',
        body: [
          'Measure remaining yarn: you need about three to four times the width of the blanket left to finish the edge.',
          'Interlock the loops: pull up the first two loops of the final row and pull the second loop through the first (or pull the first loop over the second), leaving one loop.',
          'Continue across the row: pull up a new loop, then pull the previous loop over or through it. This makes a decorative braided edge.',
          'Secure the last stitch: when one loop remains, cut the working yarn leaving a 6 to 10 inch tail, pull it through the final loop and tug it tight.',
        ],
      },
      {
        title: 'Add a border (optional)',
        body: [
          'First stitch: put your fingers through the first stitch at the edge and pull a loop of working yarn through, about two fingers wide.',
          'Chain along the edge: pull up a loop through the next edge stitch so you have two loops, then pull the working yarn through both. Repeat, keeping even tension and loop size so the edge doesn’t curve.',
          'Corners: make one normal border stitch, then pull up a second loop through the same corner stitch before moving down the next side. Twisting the new loop at the base of the corner also helps it keep its shape.',
          'Close the round by doubling up on the last stitch, cut the yarn, pull the tail through the final loop and tighten. Weave the tails through the loops on the underside, and tie the beginning and end tails together for extra security.',
        ],
      },
    ],
    terms: 'Pattern © 2026 Rustic Nastalje (Charly Prinsloo). Free for ImadeIt users. Please don’t copy, share or resell the pattern itself. You may sell blankets you make with it: credit @rusticnastalje in your listing or post.',
  },
];
