# LTX Video

A standalone desktop application for generating AI videos using the LTX-2 model, running entirely on your local GPU.

## Features

- **Local GPU Inference**: All video generation happens on your machine - no cloud required
- **Text-to-Video**: Generate videos from text descriptions
- **Image-to-Video**: Animate images with AI
- **Multiple Quality Modes**: Fast (distilled) or Pro quality
- **Audio Generation**: Optional AI-generated audio
- **Camera Motion**: Add cinematic camera movements

## System Requirements

### Minimum
- **OS**: Windows 10/11 (64-bit)
- **GPU**: NVIDIA GPU with 12GB+ VRAM (RTX 3080 or better)
- **RAM**: 16GB
- **Storage**: 20GB free space (for models)

### Recommended
- **GPU**: NVIDIA RTX 4090 / RTX 5090 with 24GB+ VRAM
- **RAM**: 32GB
- **Storage**: 50GB free space (SSD recommended)

## Installation

### For Users
1. Download the latest installer from [Releases](https://github.com/Lightricks/ltx-video/releases)
2. Run the installer
3. Launch LTX Video
4. On first run, the app will download required AI models (~15GB)

### For Developers

#### Prerequisites
- Node.js 20+
- Python 3.11+
- NVIDIA GPU with CUDA 12.1+
- uv (Python package manager)

#### Setup

```bash
# Clone the repository
git clone https://github.com/Lightricks/ltx-video.git
cd ltx-video

# Install frontend dependencies
npm install

# Set up Python backend
cd backend
uv sync
cd ..

# Run in development mode
npm run electron:dev
```

## Project Structure

```
ltx-video/
├── electron/           # Electron main process
│   ├── main.ts         # Application entry point
│   └── preload.ts      # Secure IPC bridge
├── src/                # React frontend
│   ├── components/     # UI components
│   ├── hooks/          # React hooks
│   └── App.tsx         # Main application
├── backend/            # Python FastAPI backend
│   ├── inference/      # LTX-2 pipeline wrapper
│   └── main.py         # API server
└── resources/          # Build resources
```

## Usage

1. **Enter a prompt**: Describe the video you want to generate
2. **Optional image**: Drag an image for image-to-video generation
3. **Adjust settings**: Choose quality, duration, resolution
4. **Generate**: Click "Generate video" and wait for results

### Tips for Better Results

- Use detailed, descriptive prompts
- Specify camera movements in your prompt
- For image-to-video, use high-quality input images
- "Fast" mode is great for previews, "Pro" for final renders

## Performance Benchmarks

| Configuration | Resolution | Duration | Time (RTX 5090) |
|--------------|------------|----------|-----------------|
| Fast         | 720p       | 5s       | ~48s            |
| Fast         | 1080p      | 5s       | ~85s            |
| Fast         | 720p       | 10s      | ~79s            |
| Pro          | 720p       | 5s       | ~122s           |

## License

MIT License - See [LICENSE](LICENSE) for details.

## Credits

- LTX-2 Model by [Lightricks](https://www.lightricks.com/)
- Built with Electron, React, FastAPI, and PyTorch
