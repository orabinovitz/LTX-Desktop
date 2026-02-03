"""Test with the user's train image."""
import torch
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video
from PIL import Image
import time

print(f"PyTorch version: {torch.__version__}")
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")

print("\nLoading I2V pipeline...")
start = time.time()
pipe = LTXImageToVideoPipeline.from_pretrained(
    "Lightricks/LTX-Video",
    torch_dtype=torch.bfloat16,
)
pipe = pipe.to("cuda")
print(f"Pipeline loaded in {time.time() - start:.1f}s")

# Load user's train image
print("\nLoading and preprocessing train image...")
img = Image.open("test_train.png").convert("RGB")
print(f"Original size: {img.size}")

# Preprocess like the app does - resize to 768x512
target_w, target_h = 768, 512
img_w, img_h = img.size
target_ratio = target_w / target_h
img_ratio = img_w / img_h

if img_ratio > target_ratio:
    new_h = target_h
    new_w = int(img_w * (target_h / img_h))
else:
    new_w = target_w
    new_h = int(img_h * (target_w / img_w))

resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
left = (new_w - target_w) // 2
top = (new_h - target_h) // 2
final_img = resized.crop((left, top, left + target_w, top + target_h))
print(f"Preprocessed: {img.size} -> {final_img.size}")

print("\n" + "="*50)
print("Starting video generation...")
print("Prompt: Steam train passes by")
print("Resolution: 768x512, Frames: 121, Steps: 25")
print("="*50)

start = time.time()
output = pipe(
    image=final_img,
    prompt="Steam train passes by",
    num_frames=121,  # 5 seconds at 24fps
    height=512,
    width=768,
    num_inference_steps=25,
    guidance_scale=3.0,
    generator=torch.Generator("cuda").manual_seed(42),
)
inference_time = time.time() - start
print(f"\nInference completed in {inference_time:.1f} seconds")

print("Exporting video...")
export_to_video(output.frames[0], "train_video.mp4", fps=24)
print("Done! Video saved as train_video.mp4")
