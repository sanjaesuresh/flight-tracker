import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Filters } from '../Filters.tsx';
import { emptyFilter } from '../../lib/filter';

describe('Filters', () => {
  it('emits a non-stop filter when Stops is changed', async () => {
    const onChange = vi.fn();
    render(<Filters filter={emptyFilter()} onChange={onChange} airlines={['Delta', 'United']} />);
    await userEvent.selectOptions(screen.getByLabelText(/stops/i), 'Non-stop only');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxStops: 0 }));
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
});
