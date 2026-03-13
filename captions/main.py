import stable_whisper
import json
import sys
import torch

audio_path = "./audio.mp3"
transcript_path = "./transcript.txt"
output_path = "./captions/output.json"

device = "cuda" if torch.cuda.is_available() else "cpu"
# Use 'cpu' or 'mps' (Apple Silicon) if needed

# Load model (start with 'small' or 'medium' for balance; 'large-v3' best but heavier)
model = stable_whisper.load_model('medium', device=device)  # or 'large-v3', 'base.en', etc.

# Read your plain text transcript
with open(transcript_path, 'r', encoding='utf-8') as f:
    transcript_text = f.read().strip()

# Perform forced alignment
# stable-ts can align directly from plain string + audio
result = model.align(audio_path, transcript_text, language='en')  # change 'en' to your lang if needed

# Convert to dict for JSON export
# result has .segments with .words list: each word has .word, .start, .end
data = {
    "segments": [
        {
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
            "words": [
                {"word": w.word.strip(), "start": w.start, "end": w.end}
                for w in seg.words
            ]
        }
        for seg in result
    ],
    "full_text": result.text
}

with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Alignment complete. Output saved to {output_path}")