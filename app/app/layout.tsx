import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WorldSeat — strong consistency you can watch',
  description:
    'A global on-sale ticketing floor. Flip the database between Aurora DSQL (strong) and naive DynamoDB Global Tables (eventual), then break it: watch oversold stay 0 or climb.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
