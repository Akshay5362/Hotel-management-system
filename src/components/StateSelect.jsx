import React, { useState, useEffect, useRef } from 'react';
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from '../constants/indianStates';

export default function StateSelect({
  value = '',
  onChange,
  hasError = false,
  placeholder = 'Select State / UT',
  disabled = false,
  id = 'state-select',
  required = false
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Sync searchTerm or internal state when value prop changes
  useEffect(() => {
    if (!isOpen) {
      setSearchTerm(value || '');
    }
  }, [value, isOpen]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearchTerm(value || '');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [value]);

  // Filtered lists
  const query = (isOpen ? searchTerm : '').trim().toLowerCase();

  const filteredStates = INDIAN_STATES.filter(s =>
    s.toLowerCase().includes(query)
  );

  const filteredUTs = INDIAN_UNION_TERRITORIES.filter(u =>
    u.toLowerCase().includes(query)
  );

  // Flattened list for keyboard navigation
  const flatOptions = [...filteredStates, ...filteredUTs];

  // Handle option click
  const handleSelectOption = (opt) => {
    onChange(opt);
    setSearchTerm(opt);
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(0);
      } else {
        setHighlightedIndex(prev => (prev + 1 < flatOptions.length ? prev + 1 : 0));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(flatOptions.length - 1);
      } else {
        setHighlightedIndex(prev => (prev - 1 >= 0 ? prev - 1 : flatOptions.length - 1));
      }
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < flatOptions.length) {
        e.preventDefault();
        handleSelectOption(flatOptions[highlightedIndex]);
      } else if (isOpen && flatOptions.length === 1) {
        e.preventDefault();
        handleSelectOption(flatOptions[0]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setSearchTerm(value || '');
    } else if (e.key === 'Tab') {
      if (isOpen) {
        if (highlightedIndex >= 0 && highlightedIndex < flatOptions.length) {
          handleSelectOption(flatOptions[highlightedIndex]);
        } else {
          setIsOpen(false);
        }
      }
    }
  };

  // Auto-scroll highlighted item into view
  useEffect(() => {
    if (isOpen && listRef.current && highlightedIndex >= 0) {
      const activeEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, isOpen]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%' }}
      onKeyDown={handleKeyDown}
    >
      {/* Combobox Input */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          width: '100%'
        }}
      >
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          required={required && !value}
          disabled={disabled}
          placeholder={placeholder}
          value={isOpen ? searchTerm : value}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            if (!isOpen) setIsOpen(true);
            setHighlightedIndex(0);
          }}
          onFocus={() => {
            if (!disabled) {
              setIsOpen(true);
              setSearchTerm('');
              setHighlightedIndex(0);
            }
          }}
          style={{
            background: hasError ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.07)',
            border: `1px solid ${hasError ? '#ef4444' : 'rgba(255,255,255,0.15)'}`,
            borderRadius: '8px',
            color: '#f8fafc',
            padding: '9px 34px 9px 12px',
            width: '100%',
            fontSize: '0.9rem',
            outline: 'none',
            boxSizing: 'border-box',
            cursor: disabled ? 'not-allowed' : 'text',
            transition: 'border-color 0.15s, background-color 0.15s'
          }}
        />

        {/* Dropdown Chevron / Clear Button */}
        <div
          onClick={() => {
            if (!disabled) {
              if (isOpen) {
                setIsOpen(false);
                setSearchTerm(value || '');
              } else {
                setIsOpen(true);
                setSearchTerm('');
                inputRef.current?.focus();
              }
            }
          }}
          style={{
            position: 'absolute',
            right: '10px',
            top: '50%',
            transform: 'translateY(-50%)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: '#94a3b8',
            fontSize: '0.75rem',
            userSelect: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '20px'
          }}
        >
          {isOpen ? '▲' : '▼'}
        </div>
      </div>

      {/* Dropdown Menu */}
      {isOpen && !disabled && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 99999,
            maxHeight: '230px',
            overflowY: 'auto',
            background: '#0f172a',
            border: '1px solid rgba(56,189,248,0.3)',
            borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.7)',
            padding: '4px 0',
            fontSize: '0.84rem'
          }}
        >
          {flatOptions.length === 0 ? (
            <div style={{ padding: '10px 14px', color: '#94a3b8', fontStyle: 'italic', textAlign: 'center' }}>
              No matching State or UT found
            </div>
          ) : (
            <>
              {/* States Section */}
              {filteredStates.length > 0 && (
                <div>
                  <div
                    style={{
                      padding: '6px 12px 4px',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      color: '#38bdf8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderBottom: '1px solid rgba(255,255,255,0.06)'
                    }}
                  >
                    States ({filteredStates.length})
                  </div>
                  {filteredStates.map((st) => {
                    const idx = flatOptions.indexOf(st);
                    const isSelected = value === st;
                    const isHighlighted = highlightedIndex === idx;
                    return (
                      <div
                        key={st}
                        data-index={idx}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelectOption(st)}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        style={{
                          padding: '7px 14px',
                          cursor: 'pointer',
                          background: isHighlighted
                            ? 'rgba(56,189,248,0.18)'
                            : isSelected
                            ? 'rgba(56,189,248,0.08)'
                            : 'transparent',
                          color: isSelected ? '#38bdf8' : '#f8fafc',
                          fontWeight: isSelected ? 700 : 400,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}
                      >
                        <span>{st}</span>
                        {isSelected && <span style={{ color: '#38bdf8', fontSize: '0.8rem' }}>✓</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Union Territories Section */}
              {filteredUTs.length > 0 && (
                <div style={{ marginTop: filteredStates.length > 0 ? '4px' : 0 }}>
                  <div
                    style={{
                      padding: '6px 12px 4px',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      color: '#a78bfa',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderTop: filteredStates.length > 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                      borderBottom: '1px solid rgba(255,255,255,0.06)'
                    }}
                  >
                    Union Territories ({filteredUTs.length})
                  </div>
                  {filteredUTs.map((ut) => {
                    const idx = flatOptions.indexOf(ut);
                    const isSelected = value === ut;
                    const isHighlighted = highlightedIndex === idx;
                    return (
                      <div
                        key={ut}
                        data-index={idx}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelectOption(ut)}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        style={{
                          padding: '7px 14px',
                          cursor: 'pointer',
                          background: isHighlighted
                            ? 'rgba(167,139,250,0.18)'
                            : isSelected
                            ? 'rgba(167,139,250,0.08)'
                            : 'transparent',
                          color: isSelected ? '#a78bfa' : '#f8fafc',
                          fontWeight: isSelected ? 700 : 400,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}
                      >
                        <span>{ut}</span>
                        {isSelected && <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>✓</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
