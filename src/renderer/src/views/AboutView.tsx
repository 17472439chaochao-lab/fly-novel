import { APP_ABOUT } from '../../../shared/about'

/** 关于页：展示应用名称、版本、作者与开源组件信息 */
export function AboutView() {
  return (
    <div>
      <div className="panel-head">
        <div>
          <h2>关于</h2>
          <p>{APP_ABOUT.tagline}</p>
        </div>
      </div>
      <div className="about-card">
        <div className="about-brand">
          <strong>{APP_ABOUT.name}</strong>
          <span>v{APP_ABOUT.version}</span>
        </div>
        <p className="about-features">{APP_ABOUT.features}</p>
        <dl className="about-meta">
          <div>
            <dt>作者</dt>
            <dd>{APP_ABOUT.author}</dd>
          </div>
          <div>
            <dt>QQ</dt>
            <dd>{APP_ABOUT.qq}</dd>
          </div>
          <div>
            <dt>邮箱</dt>
            <dd>
              <a href={`mailto:${APP_ABOUT.email}`}>{APP_ABOUT.email}</a>
            </dd>
          </div>
          <div>
            <dt>仓库</dt>
            <dd>
              <a href={APP_ABOUT.repo} target="_blank" rel="noreferrer">
                {APP_ABOUT.repo}
              </a>
            </dd>
          </div>
          <div>
            <dt>许可证</dt>
            <dd>{APP_ABOUT.license}</dd>
          </div>
        </dl>
        <p className="about-note">{APP_ABOUT.opensourceNote}</p>
        <h4>开源组件</h4>
        <ul className="about-deps">
          {APP_ABOUT.components.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>
              <span>{c.desc}</span>
              <em>{c.license}</em>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
