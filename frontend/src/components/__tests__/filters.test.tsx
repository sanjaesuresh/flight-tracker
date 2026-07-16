import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Filters } from '../Filters.tsx';
import { emptyFilter } from '../../lib/filter.js';

describe('Filters', () => {
  it('emits a non-stop filter when the 0 stops button is pressed', async () => {
    const onChange = vi.fn();
    render(<Filters filter={emptyFilter()} onChange={onChange} airlines={['Delta', 'United']} />);
    await userEvent.click(screen.getByRole('button', { name: '0' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stops: 0 }));
  });

  it('clears the stops filter when the active bucket is pressed again', async () => {
    const onChange = vi.fn();
    render(
      <Filters filter={{ ...emptyFilter(), stops: 2 }} onChange={onChange} airlines={[]} />,
    );
    // 2+ is already active, so pressing it toggles back to Any (null)
    await userEvent.click(screen.getByRole('button', { name: '2+' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stops: null }));
  });

  it('toggles an airline into the filter set', async () => {
    const onChange = vi.fn();
    render(<Filters filter={emptyFilter()} onChange={onChange} airlines={['Delta', 'United']} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Delta' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ airlines: ['Delta'] }));
  });

  it('resets all filters', async () => {
    const onChange = vi.fn();
    render(
      <Filters
        filter={{ ...emptyFilter(), priceMax: 300 }}
        onChange={onChange}
        airlines={['Delta']}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(onChange).toHaveBeenCalledWith(emptyFilter());
  });

  it('surfaces the null-return-time behavior to the user', () => {
    render(<Filters filter={emptyFilter()} onChange={vi.fn()} airlines={[]} />);
    expect(screen.getByText(/always kept/i)).toBeInTheDocument();
  });

  it('disables Reset when no filters are active, enables it once one is set', () => {
    const { rerender } = render(
      <Filters filter={emptyFilter()} onChange={vi.fn()} airlines={['Delta']} />,
    );
    expect(screen.getByRole('button', { name: /reset/i })).toBeDisabled();

    rerender(
      <Filters
        filter={{ ...emptyFilter(), priceMax: 300 }}
        onChange={vi.fn()}
        airlines={['Delta']}
      />,
    );
    expect(screen.getByRole('button', { name: /reset/i })).toBeEnabled();
  });
});
