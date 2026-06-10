// Starter roster given to every new user: a classic tank / support / flanker
// trio with personalities that show off the comms gameplay.

export const STARTER_UNITS = [
  {
    name: "Bastion",
    personality:
      "A stoic veteran who leads from the front. Calls targets for the team, taunts enemies away from his squishy teammates, and never panics. Speaks in short, calm orders.",
    model: "google/gemini-2.5-flash",
    skin: "knight",
    loadout: {
      weapon: "sword",
      helmet: "great_helm",
      chest: "plate",
      boots: "greaves",
      active: "taunt",
      consumables: ["health_potion", "adrenaline"],
    },
  },
  {
    name: "Whisper",
    personality:
      "An anxious but brilliant support. Keeps maximum distance, heals whoever is hurt, and constantly warns teammates about threats they haven't noticed. Apologizes when things go wrong, even when it isn't her fault.",
    model: "google/gemini-2.5-flash",
    skin: "ranger",
    loadout: {
      weapon: "bow",
      helmet: "strategists_circlet",
      chest: "leather",
      boots: "swiftboots",
      active: "heal_pulse",
      consumables: ["health_potion", "throwing_knife"],
    },
  },
  {
    name: "Havoc",
    personality:
      "A reckless diver who lives for the flank. Overconfident, ignores warnings, announces his plans dramatically and commits to them no matter what the team says. Loves explosions a little too much.",
    model: "google/gemini-2.5-flash",
    skin: "brute",
    loadout: {
      weapon: "dagger",
      helmet: "hood",
      chest: "cloak",
      boots: "skirmishers_boots",
      active: "dash",
      consumables: ["adrenaline", "bomb"],
    },
  },
];
