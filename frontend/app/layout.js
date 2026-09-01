import './globals.css';

export const metadata = {
  title: 'Bookworm — RAG Book Recommendation Bot',
  description: 'A retrieval-augmented book recommender built with Next.js, Express and Gemini.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
