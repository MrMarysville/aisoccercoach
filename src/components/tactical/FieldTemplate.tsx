'use client';

import type { FieldTemplate as FieldTemplateType } from '@/types';
import { FIELD_DIMENSIONS } from '@/types';

interface FieldTemplateProps {
  fieldTemplate: FieldTemplateType;
  showGrid?: boolean;
  children?: React.ReactNode;
}

export default function FieldTemplate({ fieldTemplate, showGrid = false, children }: FieldTemplateProps) {
  const dims = FIELD_DIMENSIONS[fieldTemplate];
  const { width, height } = dims;
  const pad = 2; // padding around field

  const is9v9 = fieldTemplate === '9v9';
  const penAreaWidth = is9v9 ? 12 : 16.5;
  const penAreaHeight = is9v9 ? 20 : 40.32;
  const goalAreaWidth = is9v9 ? 5 : 5.5;
  const goalAreaHeight = is9v9 ? 12 : 18.32;
  const centerRadius = is9v9 ? 5 : 9.15;
  const goalWidth = is9v9 ? 4.88 : 7.32;

  const penAreaTop = (height - penAreaHeight) / 2;
  const goalAreaTop = (height - goalAreaHeight) / 2;
  const goalTop = (height - goalWidth) / 2;

  return (
    <svg
      viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
      style={{ width: '100%', backgroundColor: '#166534', borderRadius: 'var(--radius-lg)' }}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Field surface */}
      <rect x={0} y={0} width={width} height={height} fill="#15803d" rx={0.5} />

      {/* Grass stripes */}
      {Array.from({ length: Math.ceil(width / 5) }, (_, i) => (
        i % 2 === 0 ? (
          <rect key={i} x={i * 5} y={0} width={5} height={height} fill="rgba(255,255,255,0.03)" />
        ) : null
      ))}

      {/* Field outline */}
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="white" strokeWidth={0.2} />

      {/* Halfway line */}
      <line x1={width / 2} y1={0} x2={width / 2} y2={height} stroke="white" strokeWidth={0.2} />

      {/* Center circle */}
      <circle cx={width / 2} cy={height / 2} r={centerRadius} fill="none" stroke="white" strokeWidth={0.2} />
      <circle cx={width / 2} cy={height / 2} r={0.3} fill="white" />

      {/* Left penalty area */}
      <rect x={0} y={penAreaTop} width={penAreaWidth} height={penAreaHeight} fill="none" stroke="white" strokeWidth={0.2} />

      {/* Right penalty area */}
      <rect x={width - penAreaWidth} y={penAreaTop} width={penAreaWidth} height={penAreaHeight} fill="none" stroke="white" strokeWidth={0.2} />

      {/* Left goal area */}
      <rect x={0} y={goalAreaTop} width={goalAreaWidth} height={goalAreaHeight} fill="none" stroke="white" strokeWidth={0.2} />

      {/* Right goal area */}
      <rect x={width - goalAreaWidth} y={goalAreaTop} width={goalAreaWidth} height={goalAreaHeight} fill="none" stroke="white" strokeWidth={0.2} />

      {/* Left goal */}
      <rect x={-1.5} y={goalTop} width={1.5} height={goalWidth} fill="none" stroke="white" strokeWidth={0.15} />

      {/* Right goal */}
      <rect x={width} y={goalTop} width={1.5} height={goalWidth} fill="none" stroke="white" strokeWidth={0.15} />

      {/* Corner arcs */}
      <path d={`M 1 0 A 1 1 0 0 1 0 1`} fill="none" stroke="white" strokeWidth={0.15} />
      <path d={`M ${width - 1} 0 A 1 1 0 0 0 ${width} 1`} fill="none" stroke="white" strokeWidth={0.15} />
      <path d={`M 0 ${height - 1} A 1 1 0 0 1 1 ${height}`} fill="none" stroke="white" strokeWidth={0.15} />
      <path d={`M ${width} ${height - 1} A 1 1 0 0 0 ${width - 1} ${height}`} fill="none" stroke="white" strokeWidth={0.15} />

      {/* Grid overlay */}
      {showGrid && (
        <g opacity={0.15}>
          {Array.from({ length: Math.floor(width / 5) + 1 }, (_, i) => (
            <line key={`v${i}`} x1={i * 5} y1={0} x2={i * 5} y2={height} stroke="white" strokeWidth={0.1} />
          ))}
          {Array.from({ length: Math.floor(height / 5) + 1 }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={i * 5} x2={width} y2={i * 5} stroke="white" strokeWidth={0.1} />
          ))}
        </g>
      )}

      {children}
    </svg>
  );
}
