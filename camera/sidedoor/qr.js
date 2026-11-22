import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QrCode } from 'thesidedoor/react';

export function renderQr(container, value) {
  const root = createRoot(container);
  root.render(createElement(QrCode, { value }));
  return () => root.unmount();
}
