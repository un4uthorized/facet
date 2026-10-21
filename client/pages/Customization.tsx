import { useState } from 'react';
import { ExternalLink, FileCode2, Files, Palette, SlidersHorizontal } from 'lucide-react';
import { DocumentationSettings } from './DocumentationSettings';
import { OpenApiEditor } from '../components/OpenApiEditor';
import { PagesEditor } from '../components/PagesEditor';

export function Customization({ onLogoSaved }: { onLogoSaved: (logoUrl: string) => void }) {
  const [tab, setTab] = useState('appearance');
  const tabs = [{ id: 'appearance', label: 'Aparência', icon: Palette }, { id: 'openapi', label: 'OpenAPI', icon: FileCode2 }, { id: 'pages', label: 'Páginas e menu', icon: Files }];
  return <>
    <div className="workspace-page-heading"><div><p className="workspace-eyebrow"><SlidersHorizontal /> Sua documentação, do seu jeito</p><h1>Customização</h1><p>Gerencie a identidade, a referência da API e o conteúdo do seu portal.</p></div><a className="workspace-button" href="/docs" target="_blank" rel="noreferrer">Abrir documentação <ExternalLink /></a></div>
    <nav className="cms-tabs" aria-label="Áreas de customização">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}><Icon />{label}</button>)}</nav>
    <div hidden={tab !== 'appearance'}><DocumentationSettings onLogoSaved={onLogoSaved} /></div>
    <div hidden={tab !== 'openapi'}><OpenApiEditor /></div>
    <div hidden={tab !== 'pages'}><PagesEditor /></div>
  </>;
}
