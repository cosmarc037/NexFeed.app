import React from 'react';
import { NotificationContainer } from "@/components/ui/notifications";

export default function Layout({ children }) {
  return (
    <div className="min-h-screen bg-[#f5f7f8]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        /* ITC Charter via Google Fonts approximation using Lora as closest web-safe alternative */
        @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400;1,600&display=swap');

        :root {
          --font-headline: 'Lora', 'Georgia', 'Times New Roman', serif;
          --font-body: 'Helvetica Neue', 'Helvetica', 'Arial', sans-serif;
          --primary: #fd5108;
          --primary-medium: #fe7c39;
          --primary-light: #ffaa72;
          --primary-tint1: #ffcda8;
          --primary-tint2: #ffe8d4;
          --primary-tint3: #fff5ed;
          --grey: #a1a8b3;
          --grey-medium: #b5bcc4;
          --grey-light: #cbd1d6;
          --grey-tint1: #dfe3e6;
          --grey-tint2: #eeeff1;
          --grey-tint3: #f5f7f8;
          --dark-grey: #2e343a;
        }
        
        * {
          font-family: 'Helvetica Neue', 'Helvetica', 'Arial', sans-serif;
        }

        /* Headlines and quotes use ITC Charter (Lora as web equivalent) */
        h1, h2, h3, h4, h5, h6,
        .font-headline, blockquote {
          font-family: var(--font-headline);
        }
        
        body {
          background-color: var(--grey-tint3);
        }
        
        /* Custom scrollbar */
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        
        ::-webkit-scrollbar-track {
          background: var(--grey-tint2);
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb {
          background: var(--grey-light);
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
          background: var(--grey);
        }
      `}</style>
      {children}
      <NotificationContainer />
    </div>
  );
}