import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Parley Lab · Análisis pre-partido',
  description:
    'Análisis pre-partido con goles esperados, matriz de marcadores y líneas calibradas. Un informe cualitativo generado con Gemini.',
  applicationName: 'Parley Lab',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#080B0D',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
