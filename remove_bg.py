
import sys
from rembg import remove
from PIL import Image
import io

def hex_to_rgb(hex_color):
    h = hex_color.strip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def remove_bg_and_apply_color(input_path, output_path, bg_hex="#ffffff"):
    # Read input image
    with open(input_path, 'rb') as f:
        input_data = f.read()

    # Remove background (returns PNG with alpha)
    print(f"  → Removing background...", flush=True)
    output_data = remove(input_data)

    # Open as PIL image
    fg = Image.open(io.BytesIO(output_data)).convert("RGBA")

    # Create background with requested color
    r, g, b = hex_to_rgb(bg_hex)
    bg = Image.new("RGBA", fg.size, (r, g, b, 255))

    # Composite foreground over background
    combined = Image.alpha_composite(bg, fg)

    # Save as JPEG
    final = combined.convert("RGB")
    final.save(output_path, "JPEG", quality=96)
    print(f"  ✅ Done! Saved to {output_path}", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python remove_bg.py <input> <output> [#hex_color]")
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    bg_hex      = sys.argv[3] if len(sys.argv) > 3 else "#ffffff"

    remove_bg_and_apply_color(input_path, output_path, bg_hex)