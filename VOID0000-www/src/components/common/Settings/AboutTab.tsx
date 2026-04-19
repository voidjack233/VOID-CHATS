const AboutTab = () => {
  return (
    <div className="space-y-6">
      {/* Application */}
      <div>
        <h4 className="text-sm font-semibold text-void-text-muted uppercase mb-4">Application</h4>
        
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-sm text-void-text">Version</span>
            <span className="text-sm text-void-text font-medium">1.0.0</span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-sm text-void-text">Build</span>
            <span className="text-sm text-void-text font-medium">2026.01.03</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-sm text-void-text">Environment</span>
            <span className="text-sm text-void-text font-medium">Production</span>
          </div>
        </div>
      </div>

      {/* Legal */}
      <div className="border-t border-void-border pt-6">
        <h4 className="text-sm font-semibold text-void-text-muted uppercase mb-4">Legal</h4>
        
        <div className="space-y-3">
          <a href="#" className="block text-sm text-blue-400 hover:text-blue-300 transition-colors">
            Terms of Service
          </a>
          <a href="#" className="block text-sm text-blue-400 hover:text-blue-300 transition-colors">
            Privacy Policy
          </a>
          <a href="#" className="block text-sm text-blue-400 hover:text-blue-300 transition-colors">
            Licenses
          </a>
        </div>
      </div>

      {/* Credits */}
      <div className="border-t border-void-border pt-6">
        <h4 className="text-sm font-semibold text-void-text-muted uppercase mb-4">Credits</h4>
        
        <p className="text-sm text-void-text-muted leading-relaxed">
          Built with React, TypeScript, and Tailwind CSS. Special thanks to the open-source community.
        </p>
      </div>
    </div>
  );
};

export default AboutTab;