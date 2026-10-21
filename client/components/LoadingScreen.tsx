export function LoadingScreen({ active = true, label = 'Carregando…' }: { active?: boolean; label?: string }) {
  return <div className={`page-loading${active ? ' is-active' : ''}`} aria-hidden={!active}>
    <div className="page-loading__skeleton" aria-hidden="true">
      <div className="page-loading__sidebar"><i /><i /><i /><i /><i /></div>
      <div className="page-loading__content"><i /><i /><i /><div><i /><i /><i /></div></div>
    </div>
    {active && <span className="page-loading__label" role="status"><span aria-hidden="true" />{label}</span>}
  </div>;
}
