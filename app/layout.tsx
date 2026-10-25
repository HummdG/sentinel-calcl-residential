import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sentinel Savings Calculator',
  description:
    'Sentinel EMS financial impact calculator: the added benefit of energy management on top of a solar + battery system.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
