use url::Url;

/// Account, token, and names PIR base URLs derived from one account URL.
#[derive(Debug)]
pub struct PirUrls {
    pub accounts: String,
    pub tokens: String,
    pub names: String,
}

/// Accounts stay on `base`. Tokens are the same host at port+1, names at port+2.
///
/// # Errors
///
/// Returns when `base` is not a URL, or when it has no explicit port.
pub fn derive_pir_urls(base: &str) -> Result<PirUrls, String> {
    Ok(PirUrls {
        accounts: shift_port(base, 0)?,
        tokens: shift_port(base, 1)?,
        names: shift_port(base, 2)?,
    })
}

fn shift_port(base: &str, delta: u16) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid PIR URL {base:?}: {e}"))?;
    let port = url.port().ok_or_else(|| {
        format!(
            "PIR URL {base:?} has no explicit port; token and names servers are the next two ports"
        )
    })?;
    let next = port
        .checked_add(delta)
        .ok_or_else(|| format!("PIR port {port} + {delta} overflows"))?;
    url.set_port(Some(next))
        .map_err(|()| format!("cannot set port on {base}"))?;
    let rendered = url.to_string();
    Ok(rendered.trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_url_implies_the_next_two_ports() {
        let urls = derive_pir_urls("http://host:18090").unwrap();
        assert_eq!(urls.accounts, "http://host:18090");
        assert_eq!(urls.tokens, "http://host:18091");
        assert_eq!(urls.names, "http://host:18092");
    }

    #[test]
    fn a_trailing_slash_and_path_are_kept() {
        let urls = derive_pir_urls("http://host:18090/pir/").unwrap();
        assert_eq!(urls.accounts, "http://host:18090/pir");
        assert_eq!(urls.names, "http://host:18092/pir");
    }

    #[test]
    fn a_url_without_a_port_is_refused() {
        let err = derive_pir_urls("http://host").unwrap_err();
        assert!(err.contains("no explicit port"), "{err}");
    }
}
