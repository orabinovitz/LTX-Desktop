# Models Folder

This folder contains the AI models for video and image generation. 
**Total size: ~150GB** - These files are gitignored to keep the repository manageable.

## Models Included

### LTX-2 (Video Generation)
- `ltx-2/ltx-2-19b-distilled-fp8.safetensors` - Main video generation model
- `ltx-2/ltx-2-spatial-upscaler-x2-1.0.safetensors` - 2x upscaler
- `ltx-2/ltx-2-19b-distilled-lora-384.safetensors` - LoRA weights
- `ltx-2/text_encoder/` - Gemma text encoder
- `ltx-2/tokenizer/` - Text tokenizer

### FLUX.2 Klein 4B (Image Generation)
- `FLUX.2-klein-4B/` - Complete Flux model for fast image generation

## Downloading Models on a New Machine

The application will auto-download models on first run, but you can also download manually:

### Option 1: Using HuggingFace CLI (Recommended)
```powershell
# Install HF CLI if not already installed
pip install huggingface-hub

# Download FLUX.2 Klein 4B
hf download black-forest-labs/FLUX.2-klein-4B --local-dir ./FLUX.2-klein-4B

# Download LTX-2 (requires access to Lightricks repo)
# The app will auto-download from the official Lightricks/LTX-2 repo
```

### Option 2: Copy from Another Machine
Simply copy the entire `models/` folder from a machine where models are already downloaded.

## Notes
- First generation will be slower as models load into VRAM
- FLUX.2 uses ~10GB VRAM
- LTX-2 uses ~15GB VRAM
- Switching between image and video generation unloads one model to load the other
