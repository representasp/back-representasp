const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF AUDITORIA FINAL] CONSOLIDANDO CONTADORES: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA E ESCOLA [LOG #4]
        // ----------------------------------------------------------
        let infoTurma = {};
        let escolaId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            escolaId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro Turma: ${err.message}`); }

        // ----------------------------------------------------------
        // 3. IDENTIFICAR BIMESTRE ATIVO DINAMICAMENTE [LOG #4]
        // ----------------------------------------------------------
        let numeroBimestreAtivo = 2; // Padrão baseado na auditoria temporal (Junho = 2º Bimestre)
        try {
            if (escolaId) {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${escolaId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true);
                    if (bAtivo?.NumeroBimestre) {
                        numeroBimestreAtivo = bAtivo.NumeroBimestre;
                    }
                }
            }
        } catch (errBim) { console.error(`[BFF] Erro ao mapear Bimestre: ${errBim.message}`); }

        // ----------------------------------------------------------
        // 4. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                }
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake IPTV: ${err.message}`); }

        // ----------------------------------------------------------
        // 5. BUSCAR AVALIAÇÕES FILTRADAS POR BIMESTRE E NOTA [LOG #28]
        // ----------------------------------------------------------
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const dadosProvas = avalRes.data?.data || avalRes.data || [];
            if (Array.isArray(dadosProvas)) {
                // Filtro do App Oficial: Pertence ao bimestre corrente e ainda NÃO tem nota lançada
                totalAvaliacoes = dadosProvas.filter(a => 
                    (a.bimestre === numeroBimestreAtivo || a.Bimestre === numeroBimestreAtivo || a.SiglaBimestre == numeroBimestreAtivo) &&
                    a.avaliacaoNotaId === null && a.notaAtribuida === null
                ).length;
            }
        } catch (err) { console.error(`[BFF] Erro Avaliações: ${err.message}`); }

        // ----------------------------------------------------------
        // 6. PROCESSAMENTO ESTREITO DE TAREFAS (IP.TV) [LOG #35 e #37]
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalRedacoes = 0;

        if (authTokenIptv) {
            try {
                const configIptvBase = {
                    httpsAgent,
                    headers: { 'x-api-key': authTokenIptv, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
                };

                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                const targets = [];
                rooms.forEach(r => {
                    if (r.name) targets.push(`publication_target=${r.name}`);
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                if (targets.length === 0) targets.push('publication_target=all');
                const targetQuery = targets.join('&');

                // A. PENDENTES REAIS (Isolando provas e redações para evitar duplicidade de contadores)
                try {
                    const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=false&filter_expired=true&with_answer=true&answer_statuses=draft&answer_statuses=pending&is_exam=false&is_essay=false`;
                    const pendentesRes = await axios.get(urlPendentes, configIptvBase);
                    const rawPendentes = Array.isArray(pendentesRes.data) ? pendentesRes.data : (pendentesRes.data?.data || []);
                    
                    // Checagem se o answer_status é estritamente limpo ou nulo
                    tarefasPendentes = rawPendentes.filter(t => t.answer_status === null || t.answer_status === 'draft' || !t.answer).length;
                } catch (e) { console.error(e.message); }

                // B. EXPIRADAS DO BIMESTRE ATIVO (Tratamento já validado)
                try {
                    const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&with_answer=true&answer_statuses=draft&answer_statuses=pending`;
                    const expiradasRes = await axios.get(urlExpiradas, configIptvBase);
                    const rawExpiradas = Array.isArray(expiradasRes.data) ? expiradasRes.data : (expiradasRes.data?.data || []);
                    
                    const dataLimite = Date.now() - (50 * 24 * 60 * 60 * 1000); // 50 dias para cercar o bimestre ativo
                    tarefasExpiradas = rawExpiradas.filter(t => {
                        const dCriacao = new Date(t.expire_at || t.end_date).getTime();
                        return dCriacao > dataLimite;
                    }).length;
                } catch (e) { console.error(e.message); }

                // C. REDAÇÕES ISOLADAS
                try {
                    const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`;
                    const redacoesRes = await axios.get(urlRedacoes, configIptvBase);
                    const rawRedacoes = Array.isArray(redacoesRes.data) ? redacoesRes.data : (redacoesRes.data?.data || []);
                    totalRedacoes = rawRedacoes.length;
                } catch (e) { console.error(e.message); }

            } catch (errRooms) { console.error(errRooms.message); }
        }

        // Retorno Limpo e Consolidado
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: totalRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Crítico Geral: ${error.message}`);
        res.status(500).json({ error: "Erro de agregação no barramento principal." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Auditoria Completa ativo na porta ${PORT}`));
