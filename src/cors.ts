import type { Request, Response, NextFunction } from 'express';

// Studio is a static page on binalab.my, so the browser needs CORS to call us.
const allowed = (process.env.STUDIO_ORIGINS ?? 'https://binalab.my,https://www.binalab.my')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.header('origin');
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
