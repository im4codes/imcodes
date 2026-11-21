/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VoiceStreamingRobot,
  applyVoiceRobotLevel,
  clampVoiceRobotLevel,
  clearVoiceRobotLevel,
} from '../../src/components/VoiceStreamingRobot.js';

describe('VoiceStreamingRobot', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders pure SVG + CSS with zero text nodes and surround waveform bars', () => {
    const { container } = render(<VoiceStreamingRobot active level={0} />);
    const cursor = container.querySelector('.voice-streaming-robot-cursor') as HTMLElement;
    expect(cursor).toBeTruthy();
    expect(cursor.textContent).toBe('');
    expect(cursor.getAttribute('aria-hidden')).toBe('true');
    expect(cursor.classList.contains('is-active')).toBe(true);
    expect(cursor.classList.contains('has-level')).toBe(false);
    expect(cursor.style.getPropertyValue('--voice-robot-level')).toBe('0.000');
    expect(cursor.querySelectorAll('.voice-robot-wave-bar').length).toBeGreaterThanOrEqual(8);
    expect(cursor.querySelector('.voice-robot-wave-halo')).toBeTruthy();
  });

  it('clamps level to [0, 1] and toggles .has-level above the idle threshold', () => {
    const { container, rerender } = render(<VoiceStreamingRobot active level={1.8} />);
    const cursor = container.querySelector('.voice-streaming-robot-cursor') as HTMLElement;
    expect(cursor.classList.contains('has-level')).toBe(true);
    expect(cursor.style.getPropertyValue('--voice-robot-level')).toBe('1.000');

    rerender(<VoiceStreamingRobot active level={-0.5} />);
    expect(cursor.classList.contains('has-level')).toBe(false);
    expect(cursor.style.getPropertyValue('--voice-robot-level')).toBe('0.000');

    rerender(<VoiceStreamingRobot active level={Number.NaN} />);
    expect(cursor.classList.contains('has-level')).toBe(false);
    expect(cursor.style.getPropertyValue('--voice-robot-level')).toBe('0.000');

    expect(clampVoiceRobotLevel(0.42)).toBe(0.42);
    expect(clampVoiceRobotLevel(5)).toBe(1);
    expect(clampVoiceRobotLevel(-2)).toBe(0);
    expect(clampVoiceRobotLevel(undefined)).toBe(0);
  });

  it('supports imperative level updates for VoiceHoldHud without touching child text', () => {
    const host = document.createElement('div');
    applyVoiceRobotLevel(host, 0.65);
    expect(host.style.getPropertyValue('--voice-robot-level')).toBe('0.650');
    expect(host.getAttribute('data-voice-level-active')).toBe('true');

    applyVoiceRobotLevel(host, 0.01);
    expect(host.style.getPropertyValue('--voice-robot-level')).toBe('0.010');
    expect(host.getAttribute('data-voice-level-active')).toBeNull();

    clearVoiceRobotLevel(host);
    expect(host.style.getPropertyValue('--voice-robot-level')).toBe('');
    expect(host.getAttribute('data-voice-level-active')).toBeNull();
  });
});
