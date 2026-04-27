const badWords = [
  'fuck', 'shit', 'ass', 'bitch', 'cunt', 'dick', 'bastard', 'piss',
  'slut', 'whore', 'damn', 'cock', 'pussy', 'fag', 'nigger', 'nigga',
  'retard', 'crap', 'moron', 'idiot', 'kys', 'kill yourself', 'kkk',
  'nazi', 'rape', 'pedo', 'tranny', 'faggot',
];

const leetMap = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g',
  '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't',
};

function normalize(text) {
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[^a-zA-Z0-9\s]/g, '');
  const words = normalized.split(/\s+/);
  return words.map(w => {
    let deleet = '';
    for (const ch of w) {
      deleet += leetMap[ch] || ch;
    }
    return deleet;
  });
}

function containsProfanity(text) {
  const words = normalize(text);
  for (const word of words) {
    for (const bad of badWords) {
      if (word.includes(bad)) return true;
    }
  }
  return false;
}

function filterProfanity(text) {
  const words = text.split(/\s+/);
  const filtered = words.map(w => {
    const normalized = normalize(w);
    for (const n of normalized) {
      for (const bad of badWords) {
        if (n.includes(bad)) {
          return '*'.repeat(w.length);
        }
      }
    }
    return w;
  });
  return filtered.join(' ');
}

module.exports = { containsProfanity, filterProfanity, badWords };
