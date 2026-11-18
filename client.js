/**
 * Client half of dsh-notebook: the sidebar row and the centre-column panel.
 *
 * The panel is the same single-page UI the host already serves at /dsh-notebook/,
 * shown in a same-origin iframe. One implementation means the panel and the
 * standalone page cannot drift, and the hand-written page keeps working without
 * a second React rendering of it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notebook',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'notebook';
    const PAGE_SRC = '/dsh-notebook/?embed=1';

    /** Glyph for the sidebar row; the host paints the `currentColor` cell. */
    function NotebookGlyph(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M6.25 3.75h9.25a2.75 2.75 0 0 1 2.75 2.75v13.75H9a2.75 2.75 0 0 1-2.75-2.75z' }),
        h('path', { d: 'M6.25 17.5A2.75 2.75 0 0 1 9 14.75h9.25' }),
        h('path', { d: 'M10.25 8h4.5' }),
        h('path', { d: 'M10.25 10.75h3' }),
      );
    }

    /** The centre-column panel: the served page, filling the column. */
    function NotebookPanel() {
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          width: '100%',
          height: '100%',
          minHeight: 'calc(100vh - 120px)',
          minWidth: 0,
          overflow: 'hidden',
        },
      }, h('iframe', {
        src: PAGE_SRC,
        title: '备忘录',
        allow: 'clipboard-write',
        style: {
          flex: '1 1 auto',
          display: 'block',
          width: '100%',
          height: '100%',
          minHeight: 'calc(100vh - 120px)',
          border: '0',
          background: '#131313',
          colorScheme: 'dark',
        },
      }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: '备忘录',
        }, NotebookGlyph)));
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, NotebookPanel)));
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (error) {
              console.error('[dsh-notebook] slot dispose failed:', error);
            }
          }
        });
      },
    };
  },
});
