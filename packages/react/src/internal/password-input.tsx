'use client';

/**
 * Shared password input with visibility toggle.
 * Used by SignIn, SignUp, UserProfile.
 * - type="button" on toggle prevents form submission
 * - aria-label updates dynamically based on visibility state
 * - Password stored in uncontrolled ref (not useState — security: React DevTools)
 */

import React, { useCallback, useId, useState } from 'react';

import type { TranslationFn } from '../i18n/types.js';

interface PasswordInputProps {
  name: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  id?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  t: TranslationFn;
  onChange?: (value: string) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  'data-rakomi'?: string;
}

export function PasswordInput({
  name,
  label,
  autoComplete,
  id: customId,
  maxLength = 128,
  required = true,
  disabled = false,
  error,
  t,
  onChange,
  onBlur,
  inputRef,
  'data-rakomi': dataAttr,
}: PasswordInputProps): React.ReactElement {
  const [showPassword, setShowPassword] = useState(false);
  const generatedId = useId();
  const inputId = customId ?? generatedId;
  const errorId = `${inputId}-error`;

  const toggle = useCallback(() => {
    setShowPassword(prev => !prev);
  }, []);

  return (
    <div data-rakomi-field data-rakomi={dataAttr}>
      <label htmlFor={inputId}>{label}</label>
      <div data-rakomi-password-wrapper>
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type={showPassword ? 'text' : 'password'}
          autoComplete={autoComplete}
          maxLength={maxLength}
          required={required}
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          onBlur={onBlur}
        />
        <button
          type="button"
          onClick={toggle}
          aria-label={showPassword ? t('common.hidePassword') : t('common.showPassword')}
          data-rakomi-password-toggle
        >
          {showPassword ? '◎' : '◉'}
        </button>
      </div>
      {error && (
        <div id={errorId} data-rakomi-error>
          {error}
        </div>
      )}
    </div>
  );
}
