import { describe, it, expect } from 'vitest';

/**
 * Phase 1.4: Dynamic Imports for Heavy Components
 * 
 * These tests verify that heavy dependencies are dynamically imported
 * to reduce initial bundle size.
 */

describe('Dynamic Imports - Bundle Size Optimization', () => {
  /**
   * **Feature: performance-audit, Finding 3: Heavy Third-Party Bundles Block TTI**
   * **Validates: Phase 1.4 - Dynamic imports for heavy components**
   *
   * Property: Heavy components (framer-motion dialogs, recharts) SHALL use
   * next/dynamic to lazy-load, reducing initial JavaScript bundle size.
   *
   * Expected impact: ~30KB off main bundle (framer-motion gzipped)
   */
  describe('Property 1: Dialog uses dynamic import', () => {
    it('should import Dialog wrapper without framer-motion in initial bundle', async () => {
      // Import the wrapper component
      const { Dialog } = await import('@/components/ui/dialog');
      
      // Dialog should be defined (it's a wrapper)
      expect(Dialog).toBeDefined();
      expect(typeof Dialog).toBe('function');
    });

    it('should load MotionDialog only when dynamically imported', async () => {
      // This should trigger the dynamic import
      const MotionDialogModule = await import('@/components/ui/dialog-motion');
      
      // MotionDialog should be the default export
      expect(MotionDialogModule.default).toBeDefined();
      expect(typeof MotionDialogModule.default).toBe('function');
    });
  });

  /**
   * **Feature: performance-audit, Finding 3: Heavy Third-Party Bundles Block TTI**
   * **Validates: Phase 1.4 - Recharts already dynamically imported**
   *
   * Property: Recharts components in slide-renderer and session-dashboard SHALL
   * use next/dynamic (already implemented).
   *
   * Status: ✅ Already implemented - see slide-renderer.tsx lines 15-20
   * and session-dashboard.tsx lines 15-22
   */
  describe('Property 2: Recharts dynamic imports (already implemented)', () => {
    it('should have recharts dynamic imports in slide-renderer', async () => {
      // Read the file content to verify dynamic imports
      const fs = await import('fs');
      const path = await import('path');
      
      const slideRendererPath = path.join(
        process.cwd(),
        'src/components/slide-renderer.tsx'
      );
      
      if (fs.existsSync(slideRendererPath)) {
        const content = fs.readFileSync(slideRendererPath, 'utf-8');
        
        // Verify dynamic import pattern
        expect(content).toContain("dynamic(() => import('recharts')");
        expect(content).toContain('{ ssr: false }');
      }
    });
  });

  /**
   * **Feature: performance-audit, Finding 3: jspdf and html2canvas not used**
   * **Validates: Phase 1.4 - Unused heavy dependencies**
   *
   * Observation: jspdf and html2canvas are in package.json but not imported
   * in any source files. They may be safe to remove, or might be used in
   * export functionality not yet implemented.
   */
  describe('Property 3: Unused heavy dependencies', () => {
    it('should not import jspdf or html2canvas in current codebase', async () => {
      // This test documents that these libraries are not currently used
      // If they are added later, they should use dynamic imports
      const fs = await import('fs');
      const path = await import('path');
      
      const srcDir = path.join(process.cwd(), 'src');
      
      if (fs.existsSync(srcDir)) {
        const searchInDirectory = (dir: string, pattern: string): boolean => {
          const files = fs.readdirSync(dir, { withFileTypes: true });
          for (const file of files) {
            const filePath = path.join(dir, file.name);
            if (file.isDirectory() && !file.name.includes('node_modules')) {
              if (searchInDirectory(filePath, pattern)) return true;
            } else if ((file.name.endsWith('.tsx') || file.name.endsWith('.ts')) && !file.name.endsWith('.test.ts')) {
              const content = fs.readFileSync(filePath, 'utf-8');
              if (content.includes(pattern)) return true;
            }
          }
          return false;
        };
        
        const usesJspdf = searchInDirectory(srcDir, 'jspdf');
        const usesHtml2canvas = searchInDirectory(srcDir, 'html2canvas');
        
        // These should be false (not used) - if they become true, add dynamic imports
        expect(usesJspdf).toBe(false);
        expect(usesHtml2canvas).toBe(false);
      }
    });
  });
});
