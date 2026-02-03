"""Quick test of LTX-Video pipeline with image-to-video - matching app behavior."""
import torch
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video
from PIL import Image
import time

print(f"PyTorch version: {torch.__version__}")
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

print("\nLoading I2V pipeline...")
start = time.time()
pipe = LTXImageToVideoPipeline.from_pretrained(
    "Lightricks/LTX-Video",
    torch_dtype=torch.bfloat16,
)
pipe = pipe.to("cuda")
print(f"Pipeline loaded in {time.time() - start:.1f}s")

# Create a small image like the user's (300x168) and upscale to 768x512 like the app does
print("\nCreating and preprocessing image (like app does)...")
small_image = Image.new('RGB', (300, 168), color=(100, 150, 200))
# Add some variation
for x in range(0, 300, 30):
    for y in range(0, 168, 30):
        small_image.putpixel((x, y), (255, 0, 0))

# Upscale like app does
target_w, target_h = 768, 512
img_w, img_h = small_image.size
target_ratio = target_w / target_h
img_ratio = img_w / img_h

if img_ratio > target_ratio:
    new_h = target_h
    new_w = int(img_w * (target_h / img_h))
else:
    new_w = target_w
    new_h = int(img_h * (target_w / img_w))

upscaled = small_image.resize((new_w, new_h), Image.Resampling.LANCZOS)
left = (new_w - target_w) // 2
top = (new_h - target_h) // 2
test_image = upscaled.crop((left, top, left + target_w, top + target_h))
print(f"Image: {small_image.size} -> {test_image.size}")

print("\nGenerating video...")
print("This should take ~15 seconds...")
prompt = "The scene comes to life with gentle motion"

start = time.time()
output = pipe(
    image=test_image,
    prompt=prompt,
    num_frames=121,  # 5 seconds at 24fps
    height=512,
    width=768,
    num_inference_steps=25,
    guidance_scale=3.0,
    generator=torch.Generator("cuda").manual_seed(42),
)
print(f"Inference took {time.time() - start:.1f} seconds")

print("\nExporting video...")
export_to_video(output.frames[0], "test_i2v_output.mp4", fps=24)
print("Done! Video saved as test_i2v_output.mp4")
