// Presets provide mood. Their instruments are fallbacks, never additions to a
// user's instrumentation request. Dense controls the playing, not the band size.
export const PRESETS = Object.freeze({
  memphis: {
    name: "Memphis",
    mood: "Ominous Southern atmosphere, soulful minor-key harmony, a memorable repeating motif and deliberate space between phrases",
    instruments: "Acoustic piano with a restrained warm Rhodes supporting texture"
  },
  dark: {
    name: "Dark Trap",
    mood: "Dark cinematic tension, low-mid warmth, expressive minor-key voicings and a strong melodic motif",
    instruments: "Deep acoustic piano with a subtle sustained string texture"
  },
  atmospheric: {
    name: "Atmospheric",
    mood: "Spacious emotional harmony, gently evolving sustained notes and natural stereo depth",
    instruments: "Warm Rhodes with a soft sustained analogue pad"
  }
});

const KEY_NAMES = Object.freeze({
  Fm:"F minor","F#m":"F sharp minor",Gm:"G minor","G#m":"G sharp minor",Am:"A minor","A#m":"A sharp minor",
  Bm:"B minor",Cm:"C minor","C#m":"C sharp minor",Dm:"D minor","D#m":"D sharp minor",Em:"E minor"
});

function soundDirection(value){
  // Translate common short RU constraints locally; do not spend another API
  // call or pretend that this is a general-purpose language translator.
  return String(value||"").trim()
    .replace(/(?:как\s+у\s+|в\s+стиле\s+)?young\s+dolph\b/gi,"ominous Southern phrasing, soulful minor-key tension")
    .replace(/(?:как\s+у\s+|в\s+стиле\s+)?lil\s+baby\b/gi,"emotional minor-key melodic phrasing")
    .replace(/(?:как\s+у\s+|в\s+стиле\s+)?\bfuture\b/gi,"dark spacious melodic atmosphere")
    .replace(/без\s+(?:ударных|барабанов|бита)/gi,"drum-free")
    .replace(/без\s+(?:перкуссии)/gi,"percussion-free")
    .replace(/без\s+вокала/gi,"vocal-free")
    .replace(/только\s+(?:клавишные[\s,]+)?(?:пианино|фортепиано|рояль)/gi,"solo acoustic piano, piano as the only sound source")
    .replace(/только\s+клавишные/gi,"keyboard instruments only")
    .replace(/только\s+гитар[ауы]/gi,"solo guitar, guitar as the only sound source")
    .replace(/только\s+(?:rhodes|родес|роудс)/gi,"solo Rhodes, Rhodes as the only sound source");
}

export function durationFor(s){
  // These validated settings fit the 1..190 second text-to-audio API range.
  // Do not add two bars: there is no crop stage in this generation pipeline.
  return Number((s.bars*4*60/s.bpm).toFixed(3));
}

export function promptFor(s){
  const preset=PRESETS[s.preset];
  const direction=soundDirection(s.description);
  return [
    "TrackType: Instrument. Isolated melodic instrument stem for sampling, unaccompanied by a rhythm section.",
    direction ? direction+"." : preset.instruments+".",
    "Only the instruments described above are audible throughout.",
    s.bpm+" BPM, 4/4, "+KEY_NAMES[s.key]+".",
    "A repeating "+s.bars+"-bar melodic phrase, steady timing, immediate musical start and a loopable ending.",
    preset.mood+".",
    s.dense
      ?"Rich chord voicings and expressive melodic movement on the chosen instruments, controlled dynamics and clear phrasing."
      :"Sparse notes, natural dynamics and generous space between phrases on the chosen instruments.",
    "Close studio recording, realistic resonant timbre, warm body, detailed natural decay, subtle room ambience and clean headroom.",
    "Melody only. No drums, percussion, drum machine, 808, bassline, vocals, singing or speech.",
    "Original composition."
  ].join(" ");
}
