export const LM = { THUMB: 4, INDEX: 8, MIDDLE: 12 };

export const HT_W = 240;
export const HT_H = 180;

export const DCUTOFF = 1.0;
export const GRID = 6;

export const FILTER_STYLES = [
  {
    name: '经典双色 (Riso Duo)', id: 'riso_classic', bg: '#f8f5ee',
    layerA: { color: '#08238c', angle: 15, ink: '#08238c' },
    layerB: { color: '#ff4e91', angle: 75, ink: '#ff4e91' },
    grainAmt: 20,
  },
  {
    name: '复古卡通 (Retro Cartoon)', id: 'cartoon', bg: '#fffcf5',
    layerA: { color: '#e32d56', angle: 0, ink: '#e32d56' },
    layerB: { color: '#ffb400', angle: 0, ink: '#ffb400' },
    grainAmt: 10,
  },
  {
    name: '硬币雕刻 (Metallic Cameo)', id: 'cameo', bg: '#e2e8f0',
    layerA: { color: '#1e293b', angle: 0, ink: '#1e293b' },
    layerB: { color: '#f8fafc', angle: 0, ink: '#f8fafc' },
    grainAmt: 12,
  }
];
