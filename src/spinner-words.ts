/**
 * Words the working line can say instead of "Working…", by theme.
 *
 * A hardcoded list — nothing is fetched or generated at build time. The one
 * rule every entry follows: it must not name something a coding agent could
 * actually be doing. Whole themes about software, security and paperwork are
 * absent for that reason, and inside the themes that remain, words like
 * `Archiving`, `Staging` or `Optimizing` are gone too — a joke label that
 * reads as a status line is worse than no label at all.
 *
 * Off by default; `/omp-feel words on`.
 */
export const SPINNER_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  // 1960s Hippie (11)
  "1960sHippie": [
    "Tie-dyeing", "Peace-signing", "Flower-powering", "Woodstock jamming", "Grooving out", "Incense-burning",
    "Guitar-strumming", "Mind-expanding", "Lava lamp glowing", "VW-bus-driving", "Mantra-chanting",
  ],
  // 1980s Retro (11)
  "1980sRetro": [
    "Synthwave grooving", "Neon-glowing", "Boombox blasting", "Mixtape-making", "Arcade-mashing", "VHS-rewinding",
    "Power ballad belting", "Solving Rubik's", "Perming", "High top lacing", "Cassette-rewinding",
  ],
  // 1990s Nostalgia (11)
  "1990sNostalgia": [
    "Tamagotchi feeding", "Dial-upping", "Pog-slamming", "AOL-chatting", "Blockbuster-browsing", "Grunge-rocking",
    "Rollerblading", "Furby chattering", "Scrunchie-wearing", "Slap bracelet snapping", "Y2K-panicking",
  ],
  // Absurd / Nonsense (20)
  absurdNonsense: [
    "Flibberblasting", "Zoopaloozing", "Blurmflurping", "Quibblewomping", "Splutterglooping", "Fizzlewhacking",
    "Gobbledygooking", "Womperjawing", "Glimmerfizzing", "Zorpifying", "Blibbering", "Glumphing", "Squiffering",
    "Gromflomiting", "Snazzlewhopping", "Bumblefrizzling", "Quibblequazzing", "Skittersplonking", "Glimmerglonking",
    "Flooperdoodling",
  ],
  // Ancient Egyptian (11)
  ancientEgyptian: [
    "Mummifying", "Pharaoh ruling", "Hieroglyph carving", "Pyramid-building", "Nile-flooding", "Scarab-rolling",
    "Ankh wielding", "Sphinx-riddling", "Papyrus-scrolling", "Ra-worshipping", "Canopic-jarring",
  ],
  // Ancient Greek / Roman (11)
  ancientGreekRoman: [
    "Toga-partying", "Philosophizing", "Spartan drilling", "Gladiator thrusting", "Chariot-racing",
    "Senate-debating", "Oracle-consulting", "Laurel-wreathing", "Trojan-horsing", "Aqueduct channeling",
    "Olympic-gaming",
  ],
  // Animals (16)
  animals: [
    "Llama spitting", "Dolphin clicking", "Otter sliding", "Squirreling", "Beavering", "Fox pouncing",
    "Eagle soaring", "Panda rolling", "Kangaroo boxing", "Meerkat standing", "Sloth hanging", "Otter juggling",
    "Penguin-waddling", "Fox-trotting", "Cat-napping", "Prowling",
  ],
  // Archaeology (9)
  archaeology: [
    "Artifact-hunting", "Indiana-Jonesing", "Tomb-raiding", "Trowel-scraping", "Whip-snapping", "Temple-unearthing",
    "Relic-deciphering", "Stratigraphy layering", "Sherd-sorting",
  ],
  // Arctic / Polar (11)
  arcticPolar: [
    "Iceberg calving", "Blizzarding", "Aurora dancing", "Husky-mushing", "Permafrost freezing", "Igloo-building",
    "Ice-fishing", "Polar-bear-prowling", "Glacier-trekking", "Snowshoeing", "Frost-nipping",
  ],
  // Astronaut (11)
  astronaut: [
    "Spacewalking", "Zero-G-floating", "Mars rover driving", "Rocket-launching", "Lifting off", "Calling Houston",
    "Moon-landing", "Apollo counting down", "Hubble gazing", "Astronaut orbiting", "Reentering",
  ],
  // Astronomy (9)
  astronomy: [
    "Supernova blazing", "Black hole warping", "Redshifting", "Pulsar-pulsing", "Quasar-blazing",
    "Exoplanet-hunting", "Gravitational-lensing", "Meteor streaking", "Comet-trailing",
  ],
  // Aviation / Pilot (11)
  aviationPilot: [
    "Barrel-rolling", "Autopiloting", "Mach breaking", "Dogfighting", "Wing-waggling", "Loop de looping",
    "Red-baroning", "Formation-flying", "Afterburner-thrusting", "Carrier-landing", "Preflighting",
  ],
  // Back to the Future (10)
  backToTheFuture: [
    "Flux-capacitating", "Time-traveling", "Jumping timelines", "Exclaiming Great Scott", "Hoverboarding",
    "Hitting 88mph", "Clock-towering", "Hoverboard shredding", "Harnessing lightning", "Gigawatt-charging",
  ],
  // Bee-themed (11)
  beeThemed: [
    "Hive-minding", "Waggle-dancing", "Queen bee reigning", "Nectar-sipping", "Pollen-packing", "Honey-making",
    "Honeycomb-building", "Royal jelly feeding", "Propolis-patching", "Drone-drifting", "Stinger-flexing",
  ],
  // Biology / Evolution (5)
  biologyEvolution: [
    "Mitosis doubling", "Natural-selecting", "Speciating", "Meiosis halving", "Phenotype-shifting",
  ],
  // Board Games (11)
  boardGames: [
    "Checkmate calling", "Yahtzee rolling", "Uno-reversing", "Dice-rolling", "Meeple-moving", "Monopoly-banking",
    "Scrabble-tiling", "Risk-conquering", "Battleship-sinking", "Jenga-stacking", "Victory-pointing",
  ],
  // Camping / Outdoors (10)
  campingOutdoors: [
    "Campfire crackling", "Marshmallow roasting", "Trail-blazing", "Tent-pitching", "S'mores-toasting",
    "Bug-spraying", "Hammock-hanging", "Backpacking", "Map-folding", "Bear-proofing",
  ],
  // Cat Behavior (30)
  catBehavior: [
    "Keyboard-occupying", "Box-assessing", "3am-zooming", "Void-staring", "Sunbeam-relocating", "Knocking-off-edge",
    "Loaf-forming", "Hairball-composing", "Judgmentally-blinking", "Toe-bean-retracting", "Laser-dot-hunting",
    "Curtain-scaling", "Lap-invading", "Purr-negotiating", "Treat-manipulating", "Bird-chittering",
    "Catnip-transcending", "Biscuit-kneading", "Slow-blinking", "Chin-scratch-demanding", "Feather-toy-ambushing",
    "Windowsill-surveilling", "Cardboard-shredding", "Tail-flicking", "Human-ignoring", "Vet-carrier-evading",
    "Belly-trap-setting", "Counter-surfing", "Laptop-commandeering", "5am-yowling",
  ],
  // Chemistry (6)
  chemistry: [
    "Titrating", "Catalyzing", "Polymerizing", "Oxidizing", "Electroplating", "pH-adjusting",
  ],
  // Circus / Carnival (11)
  circusCarnival: [
    "Trapeze swinging", "Tightrope-walking", "Ringmastering", "Lion-taming", "Clowning", "Fire-breathing",
    "Human-cannonballing", "Cotton candy spinning", "Plate-spinning", "Popcorn-popping", "Carousel-spinning",
  ],
  // Coffee / Barista (11)
  coffeeBarista: [
    "Espresso-pulling", "Latte-arting", "French-pressing", "Bean-grinding", "Pour over brewing", "Milk-steaming",
    "Cold-brewing", "Aeropress extracting", "Cupping", "Shot-tamping", "Dose-weighing",
  ],
  // DC Comics (11)
  dcComics: [
    "Gotham patrolling", "Bat signaling", "Kryptonite dodging", "Speed-forcing", "Truth-lassoing", "Dark-knighting",
    "Justice League assembling", "Joker-laughing", "Boom-tubing", "Wonder Woman bracing", "Lantern-powering",
  ],
  // Deep Sea / Submarine (10)
  deepSeaSubmarine: [
    "Fathoming", "Submersing", "Periscope-peeking", "Trench-diving", "Silent-running", "Bioluminescing",
    "Depth-charging", "Bathysphere descending", "Nautilus-diving", "Kraken-wrestling",
  ],
  // Detective / Noir (11)
  detectiveNoir: [
    "Sleuthing", "Magnifying", "Whodunit solving", "Case-cracking", "Staking out", "Clue-connecting",
    "Interrogating", "Shadow-tailing", "Plot-twisting", "Fingerprint-dusting", "Red-herring-sniffing",
  ],
  // Disney / Pixar (12)
  disneyPixar: [
    "Chanting Hakuna Matata", "Pixie-dusting", "Glass slipper fitting", "Bibbidi bobbidi booing",
    "Belting Let It Go", "Dancing under the sea", "Embracing Ohana", "Launching to infinity", "WALL-E dancing",
    "Simba-roaring", "Genie-wishing", "Ratatouille cooking",
  ],
  // Doctor Who (10)
  doctorWho: [
    "TARDIS flying", "Regenerating", "Exterminating", "Sonic-screwdriving", "Timey-wimey traveling",
    "Allons-y charging", "Dalek invading", "Weeping Angel staring", "Companion-collecting", "TARDIS expanding",
  ],
  // Dune (13)
  dune: [
    "Spice-harvesting", "Sandworm-riding", "Bene Gesserit training", "Stillsuit sweating", "Weirding",
    "Sietch dwelling", "Crysknife-drawing", "Wormsign-spotting", "Melange-dreaming", "Spice trancing",
    "Shai-Hulud summoning", "Voice-commanding", "Ornithopter-flapping",
  ],
  // Firefighter (11)
  firefighter: [
    "Hose-blasting", "Ladder-climbing", "Siren-wailing", "Axe-chopping", "Smoke-venting", "Hydrant-hooking",
    "Backdraft-watching", "Rescue-carrying", "Hotspot-spotting", "Dalmatian-petting", "Fireline-holding",
  ],
  // Food (14)
  food: [
    "Pickling", "Curing", "Brining", "Dehydrating", "Smoking", "Macerating", "Spherifying", "Sourdough starting",
    "Kombucha brewing", "Canning", "Distilling", "Kimchi fermenting", "Dry-aging", "Aging",
  ],
  // Gaming (11)
  gaming: [
    "Respawning", "Speedrunning", "Leveling-up", "Button-mashing", "Looting", "Nerfing", "Buffing",
    "Glitch-hunting", "No-scoping", "Power-leveling", "Loot-farming",
  ],
  // Gardening / Botanical (10)
  gardeningBotanical: [
    "Composting", "Trellising", "Repotting", "Mulching", "Seed-starting", "Deadheading", "Grafting",
    "Transplanting", "Weed-whacking", "Worm-casting",
  ],
  // Geology (11)
  geology: [
    "Tectonic shifting", "Eroding", "Fossilizing", "Subducting", "Stratifying", "Sedimenting", "Faulting",
    "Quaking", "Geyser-spewing", "Core-drilling", "Magma-intruding",
  ],
  // Harry Potter (13)
  harryPotter: [
    "Expelliarmus casting", "Expecto Patronum summoning", "Potion-brewing", "Quidditch playing", "Wand-waving",
    "Horcrux-hunting", "Floo powder traveling", "Snitch-catching", "Accio summoning", "Alohomora unlocking",
    "Marauding", "Howler-sending", "Boggart-banishing",
  ],
  // James Bond (10)
  jamesBond: [
    "Shaken-not-stirring", "Q branch tinkering", "Aston Martin driving", "Introducing 007", "Goldfingering",
    "Bonding", "Tuxedo strutting", "Dropping one liners", "Playing Casino Royale", "Moneypenny flirting",
  ],
  // Jungle / Rainforest (11)
  jungleRainforest: [
    "Vine-swinging", "Canopy-hopping", "Toucan-calling", "Monkey-chattering", "Jaguar-stalking", "Anaconda-dodging",
    "Frog-chorusing", "Waterfall-plunging", "Butterfly-fluttering", "River-rafting", "Orchid-blooming",
  ],
  // Jurassic Park (10)
  jurassicPark: [
    "Stalking raptors", "Life finding a way", "T-Rex-roaring", "Cloning dinos", "Pondering chaos theory",
    "Outsmarting raptors", "Amber-extracting", "Sparing no expense", "Raptor-pack-hunting", "Island-escaping",
  ],
  // Knitting / Textile (10)
  knittingTextile: [
    "Crocheting", "Loom-weaving", "Yarn-bombing", "Purling", "Casting-on", "Cable-twisting", "Felting", "Quilting",
    "Bobbin-winding", "Swatch-knitting",
  ],
  // Lord of the Rings (13)
  lordOfTheRings: [
    "Second-breakfasting", "Ring-bearing", "Ent mooting", "Shadowfax riding", "Palantir-peeking", "Lembas-munching",
    "Balrog-baiting", "Precious-hoarding", "Mithril-mining", "Gandalf sparking", "Nazgul-screeching",
    "Treebeard-muttering", "Shire-frolicking",
  ],
  // Mario / Nintendo (11)
  marioNintendo: [
    "Mushrooming", "Pipe-warping", "Star-powering", "Goomba-stomping", "Coin-collecting", "Fire flower shooting",
    "Princess-rescuing", "Kart-racing", "1-up collecting", "Yoshi-riding", "Koopa shell tossing",
  ],
  // Marvel / MCU (12)
  marvelMcu: [
    "Hulk-smashing", "Wakanda forever chanting", "Web-slinging", "Thanos-snapping", "Thor-hammering",
    "Infinity Stone wielding", "Arc reactor powering", "Vibranium-forging", "Multiverse-hopping",
    "Bifrost-bridging", "Groot-rooting", "Shield-throwing",
  ],
  // Medieval / Knights (10)
  medievalKnights: [
    "Jousting", "Drawbridge lowering", "Dragon-slaying", "Castle-sieging", "Sword-swinging", "Chainmail-clanking",
    "Quest-embarking", "Round-tabling", "Chivalry upholding", "Armor-donning",
  ],
  // Meme Culture (11)
  memeCulture: [
    "Distracted glancing", "Sitting in fire", "Yeeting", "Dank-meming", "Galaxy-braining", "Pressing F",
    "Stonks rising", "Among Us sussing", "Ogre layering", "Drake-approving", "Spongebob-mocking",
  ],
  // Minecraft (9)
  minecraft: [
    "Creeper sneaking", "Ender teleporting", "Diamond-mining", "Nether-portaling", "Elytra-gliding",
    "Villager-trading", "Bed-exploding", "Biome-exploring", "Pickaxe-swinging",
  ],
  // Monty Python (11)
  montyPython: [
    "Ni-ing", "Holy-grailing", "Spam-spamming", "Silly-walking", "Dead-parroting", "Coconut-clopping",
    "French-taunting", "Nobody expecting", "Black-knight-fighting", "Lumberjack-singing", "Catapulting cows",
  ],
  // Music / Dance (15)
  musicDance: [
    "Beatboxing", "Breakdancing", "Freestyling", "Headbanging", "Moshing", "Krumping", "Voguing", "Jamming",
    "Salsa dancing", "Tangoing", "Rapping", "Djembe drumming", "Turntable scratching", "Two-stepping",
    "Moonstomping",
  ],
  // Ocean / Marine (11)
  oceanMarine: [
    "Whale-singing", "Reef building", "Tide-pooling", "Dolphin-leaping", "Shark-circling", "Octopus-inking",
    "Kelp swaying", "Wave-crashing", "Plankton-drifting", "Seashell-collecting", "Sea foam bubbling",
  ],
  // Onomatopoeia (12)
  onomatopoeia: [
    "Zapping", "Swooshing", "Clicking", "Splatting", "Boinging", "Fizzing", "Buzzing", "Bleeping", "Clunking",
    "Thunking", "Ka-powing", "Gurgling",
  ],
  // Paleontology (11)
  paleontology: [
    "Excavating", "Carbon-dating", "Fossil-hunting", "Bone-brushing", "Dino-reconstructing", "Strata-sifting",
    "Trackway-tracing", "Amber-entombing", "Coprolite-collecting", "Museum-curating", "Skull-mounting",
  ],
  // Photography (9)
  photography: [
    "Aperture tweaking", "Long exposing", "Golden hour chasing", "Shutter-clicking", "Lens-focusing",
    "Bokeh-blurring", "White-balancing", "Color-grading", "ISO-adjusting",
  ],
  // Pirate / Nautical (10)
  pirateNautical: [
    "Swashbuckling", "Plundering", "Yo-ho-hoing", "Sea-shantying", "Cannon-firing", "Jolly-rogering",
    "Plank-walking", "Parrot-perching", "Deck-swabbing", "Keelhauling",
  ],
  // Pokemon (10)
  pokemon: [
    "Pikachu shocking", "Evolving", "Pokeball-throwing", "Catchin' em all", "Gym-battling", "Shiny-hunting",
    "Team Rocket blasting", "Thunderbolting", "Master Ball throwing", "Type-matching",
  ],
  // Prohibition Era (11)
  prohibitionEra: [
    "Bootlegging", "Speakeasy sneaking", "Charleston dancing", "Moonshining", "Tommy-gunning",
    "Bathtub gin brewing", "G-man-dodging", "Jazz-clubbing", "Flapper dancing", "Gatsby partying", "Fedora-tilting",
  ],
  // Quantum Physics (9)
  quantumPhysics: [
    "Entangling", "Superposition juggling", "Schrödinger-catting", "Qubit-flipping", "Decohering",
    "Wavefunction evolving", "Uncertainty hedging", "Vacuum-fluctuating", "Spin-flipping",
  ],
  // Retro Gaming (9)
  retroGaming: [
    "Pac-Man chomping", "Tetris stacking", "Konami code entering", "Coin-inserting", "Joystick-waggling",
    "8-bit-bopping", "Warp-zoning", "Boss-rushing", "High-score-chasing",
  ],
  // Samurai / Japanese (11)
  samuraiJapanese: [
    "Bushido honoring", "Sensei bowing", "Origami folding", "Katana-drawing", "Haiku-writing",
    "Tea ceremony pouring", "Zen-meditating", "Dojo-training", "Cherry-blossoming", "Ninja-stealthing",
    "Bamboo-cutting",
  ],
  // Sci-Fi / Space (16)
  sciFiSpace: [
    "Teleporting", "Wormholing", "Hyperdriving", "Lightspeeding", "Quantumleaping", "Astrogating", "Planetforming",
    "Nanoswarming", "Warp-driving", "Lightsabering", "Phasing", "Time-warping", "Hypershifting", "Nebula-hopping",
    "Photon-blasting", "Tractor-beaming",
  ],
  // Social Media (8)
  socialMedia: [
    "Doom-swiping", "Going viral", "Hashtagging", "DM-sliding", "Clout-chasing", "Clickbaiting", "Like-farming",
    "Influencing",
  ],
  // Space / NASA (42)
  spaceNasa: [
    "Aerobraking", "Berthing", "Chilling down", "Circularizing", "Coasting", "Comet-chasing", "Crater-hopping",
    "Deorbiting", "Depressurizing", "Docking", "Downlinking", "Egressing", "Gimbaling", "Grappling",
    "Gravity-assisting", "Igniting", "Ingressing", "Jettisoning", "Midcourse-correcting", "Parachuting",
    "Plane-changing", "Pressurizing", "Reboosting", "Refueling", "Rendezvousing", "Retroburning", "Retrorocketing",
    "Rocketing", "Roving", "Slingshotting", "Splashing down", "Starhopping", "Station-keeping", "Sunskimming",
    "Thrusting", "Touching down", "Ullaging", "Undocking", "Uplinking", "Vectoring", "Venting", "Yawing",
  ],
  // Sports (16)
  sports: [
    "Skateboarding", "Snowboarding", "Surfing", "Bouldering", "Parkouring", "Skydiving", "Bungee jumping",
    "Freeclimbing", "Polevaulting", "Kayaking", "Juggling", "Slacklining", "Rock-climbing", "Shadowboxing",
    "Yoga posing", "Trampolining",
  ],
  // Star Trek (11)
  starTrek: [
    "Engaging", "Beaming-up", "Boldly-going", "Mind-melding", "Redshirting", "Assimilating", "Tribble breeding",
    "Vulcan nerve pinching", "Red-alerting", "Cheating Kobayashi", "Prime Directive following",
  ],
  // Star Wars (11)
  starWars: [
    "Jedi-mind-tricking", "Podracing", "Wookiee-roaring", "Kessel-running", "Cantina-jamming", "Bounty-hunting",
    "Sarlacc-dodging", "Ewok-dancing", "Saber-dueling", "Trench-running", "Yoda-flipping",
  ],
  // Stranger Things (11)
  strangerThings: [
    "Upside down exploring", "Mind-flaying", "Eating Eggos", "Demogorgon-dodging", "Fleeing Vecna",
    "Scooping cones", "Mall raiding", "Hellfire Club rolling", "Christmas-lighting", "Gate portaling",
    "D&D campaigning",
  ],
  // Streaming / Creator (5)
  streamingCreator: [
    "Rage-quitting", "Calling GG", "Sub-gifting", "Hype-train-riding", "Raid-hosting",
  ],
  // Studio Ghibli (10)
  studioGhibli: [
    "Totoro waiting", "Spiriting-away", "Riding catbus", "Moving castle", "Calcifer-burning", "Kiki-delivering",
    "Soot sprite scattering", "Ponyo-splashing", "Nausicaa-gliding", "Laputa-floating",
  ],
  // Synesthesia / Colors (11)
  synesthesiaColors: [
    "Ultraviolet glowing", "Iridescent shimmering", "Prism refracting", "Hue-shifting", "Chromatic-blooming",
    "Spectrum-singing", "Color-splashing", "Saturation-boosting", "Rainbow-blending", "Luminance-mapping",
    "Aura-sensing",
  ],
  // The Matrix (9)
  theMatrix: [
    "Red-pilling", "Bullet-timing", "Glitching", "Spoon-bending", "Agent-smithing", "Neo-dodging", "Denying spoons",
    "Jacking-in", "Reality-bending",
  ],
  // The Office (12)
  theOffice: [
    "Dropping innuendos", "Chili-spilling", "Assistant managing", "Stapler-jello-ing", "Prison-miking",
    "Beet-farming", "Jim-pranking", "Shuffling paper", "Botching math", "Midnight screening", "Dundie-awarding",
    "Snatching pretzels",
  ],
  // Trading / Crypto (10)
  tradingCrypto: [
    "Hodling", "Longing", "Shorting", "Staking", "Minting", "Degening", "Apeing", "Mooning", "Yieldfarming",
    "Arbitraging",
  ],
  // Victorian / Steampunk (11)
  victorianSteampunk: [
    "Haberdashing", "Clockwork tinkering", "Monocle-adjusting", "Airship-sailing", "Gear-turning",
    "Cogwheel turning", "Brass-polishing", "Top hat tipping", "Steam-hissing", "Goggles adjusting",
    "Automaton-winding",
  ],
  // Viking / Norse (11)
  vikingNorse: [
    "Pillaging", "Berserking", "Valhalla calling", "Longship-rowing", "Rune-carving", "Shield-walling",
    "Mead hall toasting", "Saga-telling", "Axe-throwing", "Ragnarok-prepping", "Fjord-sailing",
  ],
  // Volcanic (11)
  volcanic: [
    "Erupting", "Lava-flowing", "Magma rising", "Ash cloud billowing", "Pyroclastic surging", "Caldera-collapsing",
    "Pumice-floating", "Fumarole-smoking", "Tephra-raining", "Burying Pompeii", "Basalt-cooling",
  ],
  // Weather / Storms (11)
  weatherStorms: [
    "Monsoon raging", "Tornado twisting", "Lightning-striking", "Thunder-rumbling", "Hurricane-eyeing",
    "Cyclone-spinning", "Hail-pelting", "Rainbow-arching", "Fog-rolling", "Downpouring", "Barometer-watching",
  ],
  // Whimsical (20)
  whimsical: [
    "Giggling", "Daydreaming", "Whimsy whirling", "Twinkling", "Bouncing", "Hopscotching", "Whistling",
    "Fiddlesticking", "Gibbering", "Whiffling", "Bumbling", "Swooning", "Glimmering", "Sparkling", "Jesting",
    "Doodad fiddling", "Stargazing", "Galumphing", "Bamboozling", "Disco ball grooving",
  ],
  // Wild West / Cowboy (11)
  wildWestCowboy: [
    "Lasso-ing", "Tumbleweed rolling", "Facing a showdown", "Quick-drawing", "Saloon-swinging", "Gold-rushing",
    "Cattle-driving", "Spur-jingling", "Wanted poster nailing", "Campfire-storying", "Revolver-spinning",
  ],
  // Wine / Sommelier (10)
  wineSommelier: [
    "Decanting", "Corking", "Aerating", "Barrel-aging", "Vintage-selecting", "Bouquet-sniffing", "Cellar-stocking",
    "Tannin-softening", "Terroir-tasting", "Uncorking",
  ],
};

export type SpinnerCategory = keyof typeof SPINNER_CATEGORIES;
