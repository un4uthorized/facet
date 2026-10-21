import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: 'current-password' | 'new-password';
  minLength?: number;
}

export function PasswordField({ id, value, onChange, label = 'Senha', hint, required = true, disabled, autoComplete = 'new-password', minLength = 15 }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="workspace-field">
      <label htmlFor={id}>{label}{!required && <span className="workspace-field__optional">Opcional</span>}</label>
      <div className="workspace-password">
        <input id={id} name="password" type={visible ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} required={required} disabled={disabled} minLength={minLength} maxLength={128} aria-describedby={hint ? `${id}-hint` : undefined} />
        <button type="button" className="workspace-icon-button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={visible} disabled={disabled} title={visible ? 'Ocultar senha' : 'Mostrar senha'}>
          {visible ? <EyeOff /> : <Eye />}
        </button>
      </div>
      {hint && <p className="workspace-field__hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}
