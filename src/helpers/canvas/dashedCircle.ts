export type DashedCircleSection = {
  color: CanvasFillStrokeStyles['strokeStyle'],
  length: number,
  lineWidth: number
};
/**
 * Strokes the part of a square's outline between two shares of its length, clockwise from the middle
 * of the top side. The ring of a story is a square, as every avatar of the vxwm look is.
 */
function strokeSquarePart(context: CanvasRenderingContext2D, centerX: number, centerY: number, half: number, from: number, to: number) {
  const corners: [number, number][] = [
    [centerX, centerY - half],
    [centerX + half, centerY - half],
    [centerX + half, centerY + half],
    [centerX - half, centerY + half],
    [centerX - half, centerY - half],
    [centerX, centerY - half]
  ];
  // * the sides, in shares of the whole outline: half of the top one, three whole ones, half of the top one again
  const total = half * 8;
  let passed = 0;
  let started = false;
  for(let i = 0; i < corners.length - 1; ++i) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[i + 1];
    const length = Math.hypot(x2 - x1, y2 - y1);
    const start = passed / total;
    const end = (passed + length) / total;
    passed += length;
    if(end <= from || start >= to) {
      continue;
    }

    const a = (Math.max(from, start) - start) / (end - start);
    const b = (Math.min(to, end) - start) / (end - start);
    if(!started) {
      context.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a);
      started = true;
    }

    context.lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
  }
}

export default class DashedCircle {
  public canvas: HTMLCanvasElement;
  public context: CanvasRenderingContext2D;
  public dpr: number;

  private width: number;
  private height: number;
  private centerX: number;
  private centerY: number;
  private radius: number;
  private gapLength: number;
  private totalLength: number;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio;
  }

  public prepare(options: {
    radius: number,
    gap: number,
    width: number,
    height: number
  }) {
    this.canvas.width = this.width = options.width * this.dpr;
    this.canvas.height = this.height = options.height * this.dpr;

    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.radius = options.radius * this.dpr - 0.5;
    this.gapLength = options.gap * this.dpr;
    // * the length of the outline of the square around the avatar
    this.totalLength = this.radius * 8;
  }

  public render(sections: DashedCircleSection[]) {
    this.context.clearRect(0, 0, this.width, this.height);

    const totalSegments = sections.reduce((acc, section) => acc + section.length, 0);
    const totalSections = sections.length;
    this.context.lineCap = 'butt';
    if(sections.length === 1 && sections[0].length === 1) {
      this.context.setLineDash([]);
    } else {
      this.context.setLineDash([this.totalLength / totalSegments - this.gapLength, this.gapLength]);
    }

    let partSum = 0;
    for(let i = 0; i < totalSections; ++i) {
      const section = sections[i];
      const part = section.length / totalSegments;

      this.context.beginPath();
      strokeSquarePart(this.context, this.centerX, this.centerY, this.radius, partSum, partSum + part);
      this.context.strokeStyle = section.color;
      this.context.lineWidth = section.lineWidth * this.dpr;
      this.context.stroke();

      partSum += part;
    }
  };
}
