"""간단한 아이콘 PNG 파일들을 생성합니다."""
from PIL import Image, ImageDraw


def create_icon(size: int, output_path: str):
    """보라색 배경에 마스크 이모지(🎭)를 단순화한 아이콘 생성"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = size // 8
    inner_size = size - 2 * margin

    # 둥근 사각형 배경 (보라색 계열)
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 5,
        fill=(203, 166, 247),  # #cba6f7
    )

    # 마스크 모양 (두 개의 둥근 눈 + 곡선 입)
    center_x = size // 2
    eye_y = size // 2 - size // 10
    mouth_y = size // 2 + size // 8

    eye_radius = max(size // 12, 4)
    eye_offset = size // 6

    # 왼쪽 눈
    draw.ellipse(
        [center_x - eye_offset - eye_radius, eye_y - eye_radius,
         center_x - eye_offset + eye_radius, eye_y + eye_radius],
        fill=(30, 30, 46),  # #1e1e2e
    )
    # 오른쪽 눈
    draw.ellipse(
        [center_x + eye_offset - eye_radius, eye_y - eye_radius,
         center_x + eye_offset + eye_radius, eye_y + eye_radius],
        fill=(30, 30, 46),
    )

    # 미소 입 (호)
    mouth_width = size // 3
    draw.arc(
        [center_x - mouth_width // 2, mouth_y - size // 8,
         center_x + mouth_width // 2, mouth_y + size // 8],
        start=0, end=180,
        fill=(30, 30, 46),
        width=max(size // 25, 1),
    )

    img.save(output_path, "PNG")
    print(f"Created {output_path} ({size}x{size})")


if __name__ == "__main__":
    sizes = [16, 48, 128]
    for s in sizes:
        create_icon(s, f"icons/icon{s}.png")
    print("All icons generated!")
