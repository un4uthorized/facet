export function Brand({ href = '/', subtitle }: { href?: string; subtitle?: string }) {
  return <a className="workspace-brand" href={href}>
    <span>{href === '/admin' ? 'Administração' : 'Documentação da API'}</span>
    {subtitle && <span className="workspace-brand__section">{subtitle}</span>}
  </a>;
}
